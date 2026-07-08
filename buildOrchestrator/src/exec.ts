import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

export const SDKMAN_DIR = path.join(os.homedir(), '.sdkman')

/** PATH additions so maven/gradle installed via SDKMAN are always visible. */
export function toolchainPath(javaVersion?: string): { PATH: string; JAVA_HOME?: string } {
  const parts = [
    path.join(SDKMAN_DIR, 'candidates', 'maven', 'current', 'bin'),
    path.join(SDKMAN_DIR, 'candidates', 'gradle', 'current', 'bin'),
  ]
  let JAVA_HOME: string | undefined
  if (javaVersion) {
    JAVA_HOME = path.join(SDKMAN_DIR, 'candidates', 'java', javaVersion)
    parts.unshift(path.join(JAVA_HOME, 'bin'))
  }
  parts.push(process.env.PATH ?? '')
  return { PATH: parts.join(':'), JAVA_HOME }
}

/**
 * Runs a bash command with a hard timeout and full output capture.
 * Never throws on non-zero exit — callers inspect exitCode.
 */
export function runShell(
  command: string,
  opts: { cwd?: string; timeoutMs: number; javaVersion?: string; maxBuffer?: number },
): Promise<ExecResult> {
  const started = Date.now()
  const { PATH, JAVA_HOME } = toolchainPath(opts.javaVersion)
  const maxBuffer = opts.maxBuffer ?? 20 * 1024 * 1024

  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd: opts.cwd,
      env: { ...process.env, PATH, ...(JAVA_HOME ? { JAVA_HOME } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)

    child.stdout.on('data', (d) => {
      if (stdout.length < maxBuffer) stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < maxBuffer) stderr += d.toString()
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        exitCode: code ?? (timedOut ? 124 : 1),
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        exitCode: 127,
        stdout,
        stderr: `${stderr}\n${String(err)}`,
        durationMs: Date.now() - started,
        timedOut,
      })
    })
  })
}
