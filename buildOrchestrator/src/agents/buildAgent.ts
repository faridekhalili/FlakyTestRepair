import { Agent, SlidingWindowConversationManager } from '@strands-agents/sdk'
import { config } from '../config.js'
import { createModel } from '../model.js'
import { createInspectTool } from '../tools/inspect.js'
import { createReadFileTool } from '../tools/files.js'
import { createReportTool } from '../tools/report.js'
import { createRunCommandTool } from '../tools/shell.js'
import { installToolchain, listToolchains, searchJavaVersions } from '../tools/toolchain.js'
import type { AgentReport, BuildTask } from '../types.js'

const SYSTEM_PROMPT = `
You are a build engineer agent. You are given one Java project, already cloned
and checked out at a specific historical commit. Your goal: get the project to
a state where its tests are RUNNABLE — main sources AND test sources compile.
You do NOT run the full test suite.

Workflow:
1. Call inspect_project first. It tells you the build system, wrappers, and
   Java version hints.
2. Decide which JDK the commit needs. Trust explicit hints (maven.compiler.source,
   sourceCompatibility). If there are no hints, older projects (pre-2020 commits)
   usually need JDK 8; newer ones 11 or 17. Check list_toolchains; install what
   you need with search_java_versions + install_toolchain. Only ever use JDK
   version ids returned by those tools (e.g. "8.0.472-amzn") — never invent one.
   If sources target Java 5/6/7, you still need JDK 8: newer javac refuses
   "Source option 5/6/7 is no longer supported", and -Dmaven.compiler.source
   overrides will NOT fix that.
3. Compile main + test sources:
   - Maven: prefer "./mvnw" if present, else "mvn". Run
     "mvn -B -DskipTests -Dmaven.javadoc.skip=true -Denforcer.skip=true test-compile"
     (drop flags that cause problems). Always pass javaVersion to run_command.
   - Gradle: prefer "./gradlew". Run "./gradlew testClasses -x test".
4. If it fails, read the error (stdoutTail / read_file on the log), diagnose,
   and retry with a fix. Common historical-commit issues:
   - "invalid target release: N" or "invalid source release: N" → the pom PINS
     Java N; you MUST re-run with javaVersion set to a JDK of major version N
     (install it if needed). -Dmaven.compiler.source/target overrides can NOT
     fix this — the pom wins. Do not waste attempts on compiler flags.
   - Wrong JDK (removed javax APIs, module errors) → switch JDK.
   - "Could not find artifact X ...-SNAPSHOT" where X's groupId belongs to this
     same project → a sibling module produces that artifact, and test-compile
     never packages it. Escalate to
     "mvn -B -DskipTests -Dinvoker.skip=true install" (this still compiles
     test sources, satisfies the success criterion, and resolves inter-module
     artifacts like test-jars and features.xml; invoker.skip avoids running
     maven-invoker-plugin integration jobs that are irrelevant here).
     If install ALSO fails (e.g. karaf-maven-plugin verify errors), don't fight
     it: instead exclude the OSGi/karaf integration-test modules that consume
     those attached artifacts and go back to test-compile. Verified example for
     apache/cxf:
       mvn -B -DskipTests -Dmaven.javadoc.skip=true -Denforcer.skip=true
         -pl '!:cxf-services-sts-systests-itests,!:cxf-services-xkms-itests,!:org.apache.cxf.osgi.itests'
         test-compile
   - HTTP Maven repos blocked → add -Dmaven.wagon.http.ssl.insecure or mirror to HTTPS
     via a local settings.xml written inside the project directory.
   - Enforcer/javadoc/checkstyle/license plugins failing → skip them with -D flags.
   - protoc "osx-aarch_64" artifact not found → this machine is an Apple Silicon Mac
     and old protobuf never published ARM binaries. Add this flag COPIED VERBATIM,
     it is "os.detected.classifier", no other property name works:
       -Dos.detected.classifier=osx-x86_64
     (the Intel protoc then runs under Rosetta). Do NOT invent variants like
     -Dprotoc.classifier — they are silently ignored.
   - Gradle too old for your JDK → the wrapper pins Gradle; pick the JDK that
     matches the era of the Gradle wrapper version instead.
   - frontend-maven-plugin / exec-maven-plugin failures involving node, npm,
     yarn, or node-gyp (dead Node download URLs, native build errors) → those
     JS/UI modules are irrelevant to Java tests. Exclude them from the reactor
     (see the -pl rule below) and note the exclusion in your report.
   - git-commit-id-plugin "Missing commit" / "Walk failure" → the checkout is
     shallow. Run "git fetch --unshallow origin" in the project root, then retry.

CRITICAL Maven syntax rule — excluding a module from the reactor:
  Use -pl with a COLON before the artifactId:   -pl '!:seata-console'
  Multiple:                                     -pl '!:mod-a,!:mod-b'
  Without the colon (-pl !seata-console) Maven treats it as a directory path
  and fails with "Could not find the selected project in the reactor".
  When you exclude a module, modules that depend on it may then fail — exclude
  those consumers too rather than reverting.
  Batch exclusions: before retrying, list ALL modules of the same kind (every
  UI/frontend module, every itests module) and exclude them in ONE command —
  never peel one module per attempt; full builds cost minutes each.
  And before ANY exclusion: re-read the error. If it matches a rule above
  (protoc classifier, invalid release, missing sibling SNAPSHOT), apply that
  rule — exclusions do not fix those.
5. Success criterion: the test-compile / testClasses command exits 0. For huge
   multi-module repos, building the whole tree is preferred; if a single module
   is fundamentally broken (e.g. needs docker), you may exclude it with Maven
   "-pl !module" or Gradle "-x :module:..." and note that in your report.

Rules:
- Make at most 5 distinct build attempts. Do not repeat an identical command.
- Never modify test code. Build config tweaks (settings.xml, -D flags) are fine.
- You MUST finish by calling report_result exactly once — status "success" only
  if the final compile command exited 0.
`.trim()

export interface BuildAgentRun {
  runTask: () => Promise<{
    report?: AgentReport
    finalText: string
    stoppedEarly: boolean
    stopReason: string
    tokens?: { input: number; output: number; total: number }
    turns?: number
  }>
}

/**
 * A fresh agent per (project, sha): tools are closed over the task so the
 * agent can only touch its own checkout, and no context leaks between the
 * 61 tasks.
 */
export function createBuildAgent(task: BuildTask, logDir: string): BuildAgentRun {
  const { reportResult, getReport } = createReportTool()

  const agent = new Agent({
    name: `build-${task.id}`,
    model: createModel(),
    printer: false,
    // The SDK default is a 40-MESSAGE sliding window, which collides with our
    // 40-TURN cap (a turn is ~2+ messages) and fails to trim around tool-use
    // pairs. Make the window larger than any conversation our turn/token caps
    // allow, so trimming never kicks in and the explicit caps stay in charge.
    conversationManager: new SlidingWindowConversationManager({
      windowSize: config.taskMaxTurns * 4,
    }),
    systemPrompt: SYSTEM_PROMPT,
    tools: [
      createInspectTool(task),
      listToolchains,
      searchJavaVersions,
      installToolchain,
      createRunCommandTool(task, logDir),
      createReadFileTool(task),
      reportResult,
    ],
  })

  return {
    runTask: async () => {
      const result = await agent.invoke(
        `Set up and build ${task.project} at commit ${task.sha}. ` +
          `The checkout is at ${task.dir}. Start with inspect_project.`,
        {
          // Cost guards: bound wall-clock (provider-retry spirals), total
          // tokens (context blowups), and turns (command thrash) per task.
          cancelSignal: AbortSignal.timeout(config.taskTimeoutMs),
          limits: { turns: config.taskMaxTurns, totalTokens: config.taskTokenBudget },
        },
      )
      const finalText = result.lastMessage.content
        .map((block) => ('text' in block ? block.text : ''))
        .join('')
      const stoppedEarly = ['cancelled', 'limitTurns', 'limitTotalTokens', 'limitOutputTokens'].includes(
        result.stopReason,
      )
      const invocation = result.metrics?.latestAgentInvocation
      const tokens = invocation?.usage
        ? {
            input: invocation.usage.inputTokens,
            output: invocation.usage.outputTokens,
            total: invocation.usage.totalTokens,
          }
        : undefined
      return {
        report: getReport(),
        finalText,
        stoppedEarly,
        stopReason: result.stopReason,
        tokens,
        turns: invocation?.cycles.length,
      }
    },
  }
}
