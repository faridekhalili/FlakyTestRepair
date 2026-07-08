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

      // Models chronically write Maven exclusions as "!module" instead of
      // "!:artifactId"; that only works when "module" is a real directory
      // path. Reject the broken form before Maven wastes minutes on it.
      const plMatch = /(?:^|\s)(?:-pl|--projects)[=\s]+['"]?([^\s'"]+)/.exec(command)
      if (plMatch) {
        for (const segment of plMatch[1].split(',')) {
          if (!segment.startsWith('!') || segment.startsWith('!:')) continue
          const asPath = segment.slice(1)
          if (!fs.existsSync(path.resolve(resolvedCwd, asPath))) {
            throw new Error(
              `Bad -pl exclusion "${segment}": "${asPath}" is not a module directory, ` +
                `so Maven will fail with "Could not find the selected project in the reactor". ` +
                `To exclude by artifactId, add a colon: "!:${asPath}".`,
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

      console.log(`    $ ${command}${javaVersion ? `  [java ${javaVersion}]` : ''}`)
      const result = await runShell(command, {
        cwd: resolvedCwd,
        timeoutMs: (timeoutSeconds ?? config.commandTimeoutMs / 1000) * 1000,
        javaVersion,
      })

      seq += 1
      const logFile = path.join(logDir, `${String(seq).padStart(3, '0')}.log`)
      fs.writeFileSync(
        logFile,
        `$ ${command}\n[cwd: ${resolvedCwd}] [java: ${javaVersion ?? 'default'}] [exit: ${result.exitCode}]\n\n` +
          `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`,
      )
      console.log(`      ↳ exit ${result.exitCode} in ${(result.durationMs / 1000).toFixed(1)}s`)

      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationSeconds: Math.round(result.durationMs / 1000),
        logFile,
        stdoutTail: tail(result.stdout, config.logTailChars),
        stderrTail: tail(result.stderr, config.logTailChars / 2),
      }
    },
  })
}
