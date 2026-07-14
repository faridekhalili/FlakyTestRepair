import { tool } from '@strands-agents/sdk'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { config, paths } from '../config.js'
import { runShell, SDKMAN_DIR } from '../exec.js'
import type { BuildTask } from '../types.js'

/** Commands the agent must never run, regardless of what it decides. */
const DENY_PATTERNS: RegExp[] = [
  /\bsudo\b/,
  /\brm\s+-rf\s+[/~]/,
  /\bgit\s+push\b/,
  /\bshutdown\b|\breboot\b/,
  /curl[^|]*\|\s*(ba)?sh/,
]

function tail(text: string, chars: number): string {
  return text.length <= chars ? text : `…[truncated, see log file]…\n${text.slice(-chars)}`
}

/**
 * Scan every pom.xml in the checkout for node/npm frontend plugins, so the
 * frontend hint can name ALL the UI modules at once instead of letting the
 * model discover them one failing multi-minute build at a time.
 */
const frontendModulesCache = new Map<string, string[]>()
function findFrontendModules(rootDir: string): string[] {
  const cached = frontendModulesCache.get(rootDir)
  if (cached) return cached
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'target' || entry.name === 'node_modules' || entry.name === 'src') continue
        walk(path.join(dir, entry.name))
      } else if (entry.name === 'pom.xml') {
        const content = fs.readFileSync(path.join(dir, entry.name), 'utf8')
        if (/frontend-maven-plugin|install-node-and-npm|<id>npm[ -]/.test(content)) {
          const afterParent = content.split('</parent>').pop() ?? content
          const m = /<artifactId>([^<]+)<\/artifactId>/.exec(afterParent)
          if (m) found.push(m[1].trim())
        }
      }
    }
  }
  try {
    walk(rootDir)
  } catch {
    // partial scan is fine — hint degrades gracefully
  }
  frontendModulesCache.set(rootDir, found)
  return found
}

interface HintContext {
  output: string
  projectDir: string
  command: string
}

/**
 * Known failure signatures → the fix, attached to the failing command's own
 * result. Weak models ignore playbook rules buried in the system prompt but
 * reliably act on a HINT sitting next to the error they just caused.
 * A hint callback may return undefined to pass on the match (next rule runs).
 */
const HINTS: Array<{ pattern: RegExp; hint: (m: RegExpExecArray, ctx: HintContext) => string | undefined }> = [
  {
    // A module fails to resolve deps AFTER the agent excluded modules: it
    // consumes one of the excluded artifacts. Grow the exclusion list.
    pattern: /Failed to execute goal on project ([\w.-]+): Could not resolve dependencies/,
    hint: (m, ctx) => {
      const pl = /(?:-pl|--projects)[=\s]+['"]?([^\s'"]+)/.exec(ctx.command)
      if (!pl || !pl[1].includes('!')) return undefined // no exclusions in play — let other rules handle it
      return (
        `${m[1]} depends on a module in your exclusion list. ADD '!:${m[1]}' to the SAME -pl list ` +
        '(keep every previous exclusion) and re-run the same goal.'
      )
    },
  },
  {
    pattern: /protoc.*osx-aarch_64|osx-aarch_64.*protoc|protoc:exe:osx-aarch_64/i,
    hint: () =>
      'Old protobuf has no Apple Silicon protoc. Re-run with the EXACT flag -Dos.detected.classifier=osx-x86_64 ' +
      '(copy verbatim; no other property name works). Do NOT exclude modules for this.',
  },
  {
    pattern: /invalid (?:target|source) release: (\d+)/,
    hint: (m) =>
      `The pom pins Java ${m[1]}. Install a JDK ${m[1]} if needed and re-run with javaVersion set to it. ` +
      'Compiler -D flags cannot fix this. Do NOT exclude modules for this.',
  },
  {
    pattern: /class file has wrong version (\d+)\.0, should be (\d+)\.0/,
    hint: () =>
      'Stale target/ classes from a different JDK. Add "clean" to the NEXT command only ' +
      '(e.g. mvn clean test-compile ...), pick ONE javaVersion and stick to it, and DROP ' +
      'clean from later commands — clean forces full rebuilds that cost minutes.',
  },
  {
    pattern: /UnsupportedClassVersionError.*?class file version (\d+)\.0.*?up to (\d+)\.0/s,
    hint: (m) =>
      `A build plugin or dependency needs Java ${Number(m[1]) - 44}, but you are running Java ${Number(m[2]) - 44}. ` +
      `Re-run with javaVersion set to a JDK ${Number(m[1]) - 44} (or newer). Do NOT exclude modules for this.`,
  },
  {
    pattern: /Could not find the selected project in the reactor: (\S+)/,
    hint: (m) => `"${m[1]}" is not a module path. Use the colon form: -pl '!:${m[1]}'.`,
  },
  {
    pattern: /package [\w.]+\.shaded[\w.]* does not exist/,
    hint: () =>
      'A sibling "shaded" module must be packaged before anything can compile against it — plain ' +
      'test-compile can never work here. Run "mvn -B -DskipTests -Dinvoker.skip=true install" ' +
      "(and exclude genuinely broken modules with -pl '!:...' if that install fails elsewhere).",
  },
  {
    pattern: /exec-maven-plugin[\s\S]{0,200}?:exec \([^)]*\) on project ([\w.-]+)/,
    hint: (m) =>
      `Module ${m[1]} shells out to an external command (docker, scripts, ...) that cannot run here. ` +
      `Exclude it: -pl '!:${m[1]}' (keep your other flags).`,
  },
  {
    pattern: /frontend-maven-plugin|install-node-and-npm|node-gyp|'yarn install'|Could not download Node/i,
    hint: (_m, ctx) => {
      const failing = /on project ([\w.-]+):/.exec(ctx.output)?.[1]
      const mods = findFrontendModules(ctx.projectDir)
      const list = mods.length
        ? `This project's frontend modules are: ${mods.map((x) => `!:${x}`).join(',')} — exclude them ALL in ONE command: -pl '${mods.map((x) => `!:${x}`).join(',')}'.`
        : "Find the failing module name(s) in the log and exclude ALL UI/frontend modules in ONE command: -pl '!:module-a,!:module-b'."
      return `A JS/UI module (${failing ?? 'unknown'}) is failing on node/npm/yarn — irrelevant to Java tests. ${list}`
    },
  },
  {
    pattern: /Could not find artifact (\S+):(?:jar|xml|war|nar|test-jar)[^ ]*:[^ ]*SNAPSHOT/,
    hint: () =>
      'A sibling module in this repo produces that SNAPSHOT artifact. Run ' +
      '"mvn -B -DskipTests -Dinvoker.skip=true install" to build and install the whole tree locally.',
  },
]

function findHint(output: string, projectDir: string, command: string): string | undefined {
  for (const { pattern, hint } of HINTS) {
    const match = pattern.exec(output)
    if (match) {
      const result = hint(match, { output, projectDir, command })
      if (result) return result
    }
  }
  return undefined
}

/**
 * The agent's workhorse: run a shell command inside this task's checkout.
 * Full output is written to a log file; only the tail is returned to the
 * model to keep context small. An optional javaVersion switches JAVA_HOME
 * to that SDKMAN-installed JDK for this command only.
 */
/** Hard cap on commands per task — a stuck agent must stop and report, not thrash. */
const COMMAND_BUDGET = 30

/**
 * Each run of a task gets its own numbered log directory
 * (workspace/logs/<task-id>/run-NNN/) so re-runs never overwrite history.
 * Returns the new directory and this run's attempt number.
 */
export function allocateRunLogDir(taskId: string): { logDir: string; attempt: number } {
  const base = path.join(paths.logs, taskId)
  fs.mkdirSync(base, { recursive: true })
  const previous = fs
    .readdirSync(base)
    .map((entry) => /^run-(\d+)$/.exec(entry)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
  const attempt = (previous.length ? Math.max(...previous) : 0) + 1
  const logDir = path.join(base, `run-${String(attempt).padStart(3, '0')}`)
  fs.mkdirSync(logDir, { recursive: true })
  return { logDir, attempt }
}

export function createRunCommandTool(task: BuildTask, logDir: string) {
  let seq = 0
  const seen = new Map<string, { seq: number; exitCode: number }>()
  let consecutiveRejections = 0
  // Concurrency interleaves console lines from different agents; tag ours.
  const tag = `${task.project.split('/')[1]}@${task.sha.slice(0, 7)}`

  return tool({
    name: 'run_command',
    description:
      'Run a bash command in the project checkout. Returns exit code and the tail of the output; ' +
      'the full output is saved to a log file you can page through with read_file. ' +
      'Pass javaVersion (an installed SDKMAN java id, e.g. "8.0.472-amzn") to run with that JDK as JAVA_HOME.',
    inputSchema: z.object({
      command: z.string().describe('The bash command to run, e.g. "./mvnw -B test-compile"'),
      cwd: z
        .string()
        .optional()
        .describe('Directory relative to the project root to run in (default: project root)'),
      javaVersion: z
        .string()
        .optional()
        .describe('SDKMAN java version id to use as JAVA_HOME for this command'),
      timeoutSeconds: z
        .number()
        .optional()
        .describe(`Override the default timeout of ${config.commandTimeoutMs / 1000}s`),
    }),
    callback: async ({ command, cwd, javaVersion, timeoutSeconds }) => {
      if (seq >= COMMAND_BUDGET) {
        throw new Error(
          `Command budget of ${COMMAND_BUDGET} exhausted for this task. ` +
            'Stop trying new commands and call report_result with status "failure" now, ' +
            'summarizing what you tried and the last error.',
        )
      }

      for (const pattern of DENY_PATTERNS) {
        if (pattern.test(command)) {
          throw new Error(`Command rejected by policy (matched ${pattern}). Choose a different approach.`)
        }
      }

      const resolvedCwd = path.resolve(task.dir, cwd ?? '.')
      if (!resolvedCwd.startsWith(task.dir)) {
        throw new Error(`cwd must stay inside the project checkout (${task.dir})`)
      }

      // Models chronically botch -pl lists: "!module" without the colon, lists
      // that mix exclusions with bare names (which flips Maven into
      // build-ONLY-these mode), and duplicated segments. Validate every
      // segment before Maven wastes a build on it.
      const plMatch = /(?:^|\s)(?:-pl|--projects)[=\s]+['"]?([^\s'"]+)/.exec(command)
      if (plMatch) {
        const segments = plMatch[1].split(',').filter(Boolean)
        const uniq = new Set(segments)
        if (uniq.size !== segments.length) {
          throw new Error(
            `Your -pl list contains duplicate segments (${segments.length} entries, ${uniq.size} unique). ` +
              'Remove the duplicates — repeating a segment does nothing.',
          )
        }
        const excludes = segments.filter((s) => s.startsWith('!'))
        if (excludes.length > 0 && excludes.length !== segments.length) {
          throw new Error(
            `Your -pl list mixes exclusions with bare selectors (e.g. "${segments.find((s) => !s.startsWith('!'))}"). ` +
              'A bare selector switches Maven to build-ONLY-those-modules mode — almost never what you want. ' +
              "Prefix EVERY segment with '!:', e.g. -pl '!:mod-a,!:mod-b'.",
          )
        }
        for (const segment of segments) {
          const body = segment.replace(/^!/, '')
          if (body.startsWith(':')) continue // ':artifactId' selector — valid
          if (!fs.existsSync(path.resolve(resolvedCwd, body))) {
            throw new Error(
              `Bad -pl segment "${segment}": "${body}" is not a module directory, so Maven will fail ` +
                `with "Could not find the selected project in the reactor". To select by artifactId, ` +
                `use a colon: "${segment.startsWith('!') ? '!' : ''}:${body}".`,
            )
          }
        }
      }
      if (!fs.existsSync(resolvedCwd)) {
        throw new Error(
          `cwd "${cwd}" resolves to ${resolvedCwd}, which does not exist. ` +
            'cwd must be a path RELATIVE to the project root (omit it to run at the root).',
        )
      }
      if (javaVersion) {
        const javaHome = path.join(SDKMAN_DIR, 'candidates', 'java', javaVersion)
        if (!fs.existsSync(javaHome)) {
          throw new Error(
            `JDK "${javaVersion}" is not installed (${javaHome} missing). ` +
              'Use list_toolchains to see installed JDKs, or install one with install_toolchain first.',
          )
        }
      }

      // Models repeat identical failing commands verbatim; each repeat bloats
      // the conversation for zero information. Refuse exact duplicates, and
      // if the model keeps looping on rejections, demand it wrap up.
      const fingerprint = `${javaVersion ?? ''}|${resolvedCwd}|${command}`
      const prior = seen.get(fingerprint)
      if (prior) {
        consecutiveRejections += 1
        console.log(`    [${tag}] ⨯ duplicate rejected (#${consecutiveRejections}): ${command.slice(0, 80)}`)
        if (consecutiveRejections >= 3) {
          throw new Error(
            'You are looping: this is the third-plus consecutive duplicate command. ' +
              'STOP running commands. Call report_result NOW with status "failure" and ' +
              'a summary of the last real error.',
          )
        }
        throw new Error(
          `You already ran this exact command (as command #${prior.seq}, exit code ${prior.exitCode}). ` +
            'Running it again will produce the same result. Change something (flags, JDK, excluded ' +
            'modules) or call report_result with status "failure".',
        )
      }
      consecutiveRejections = 0

      console.log(`    [${tag}] $ ${command.slice(0, 160)}${javaVersion ? `  [java ${javaVersion}]` : ''}`)
      const result = await runShell(command, {
        cwd: resolvedCwd,
        timeoutMs: (timeoutSeconds ?? config.commandTimeoutMs / 1000) * 1000,
        javaVersion,
      })

      seq += 1
      seen.set(fingerprint, { seq, exitCode: result.exitCode })
      const logFile = path.join(logDir, `${String(seq).padStart(3, '0')}.log`)
      fs.writeFileSync(
        logFile,
        `$ ${command}\n[cwd: ${resolvedCwd}] [java: ${javaVersion ?? 'default'}] [exit: ${result.exitCode}]\n\n` +
          `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`,
      )
      console.log(`    [${tag}]   ↳ exit ${result.exitCode} in ${(result.durationMs / 1000).toFixed(1)}s`)

      const hint = result.exitCode === 0 ? undefined : findHint(`${result.stdout}\n${result.stderr}`, task.dir, command)
      if (hint) console.log(`    [${tag}]   💡 ${hint.slice(0, 90)}…`)

      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationSeconds: Math.round(result.durationMs / 1000),
        logFile,
        ...(hint ? { HINT_READ_THIS_FIRST: hint } : {}),
        stdoutTail: tail(result.stdout, config.logTailChars),
        stderrTail: tail(result.stderr, config.logTailChars / 2),
      }
    },
  })
}
