import fs from 'node:fs'
import path from 'node:path'
import { runShell } from './exec.js'
import type { BuildTask } from './types.js'

const GIT_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Deterministic clone + checkout — no LLM involved.
 *
 * Tries a shallow fetch of the exact SHA first (GitHub allows fetching
 * arbitrary commits with --depth 1), which keeps huge repos like quarkus
 * manageable on disk. Falls back to a full clone if the shallow path fails.
 */
export async function prepareRepo(task: BuildTask): Promise<void> {
  if (await isCheckedOut(task)) return

  fs.rmSync(task.dir, { recursive: true, force: true })
  fs.mkdirSync(task.dir, { recursive: true })

  // Shallow-fetching works only with full 40-char SHAs; a few CSV rows carry
  // abbreviated SHAs, which need the full-clone path below.
  const isFullSha = /^[0-9a-f]{40}$/i.test(task.sha)
  const shallow = isFullSha
    ? await runShell(
        [
          'git init -q .',
          `git remote add origin ${task.repoUrl}`,
          `git fetch -q --depth 1 origin ${task.sha}`,
          'git checkout -q --detach FETCH_HEAD',
        ].join(' && '),
        { cwd: task.dir, timeoutMs: GIT_TIMEOUT_MS },
      )
    : { exitCode: 1, stderr: 'abbreviated SHA, shallow fetch skipped', stdout: '' }
  if (shallow.exitCode === 0 && (await isCheckedOut(task))) return

  // Fallback: full clone (some servers reject direct SHA fetches)
  fs.rmSync(task.dir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(task.dir), { recursive: true })
  const full = await runShell(
    `git clone -q ${task.repoUrl} ${JSON.stringify(task.dir)} && cd ${JSON.stringify(task.dir)} && git checkout -q --detach ${task.sha}`,
    { timeoutMs: GIT_TIMEOUT_MS },
  )
  if (full.exitCode !== 0 || !(await isCheckedOut(task))) {
    throw new Error(
      `Failed to clone/checkout ${task.project}@${task.sha.slice(0, 7)}:\n${(full.stderr || shallow.stderr).slice(-2000)}`,
    )
  }
}

async function isCheckedOut(task: BuildTask): Promise<boolean> {
  if (!fs.existsSync(path.join(task.dir, '.git'))) return false
  const head = await runShell('git rev-parse HEAD', { cwd: task.dir, timeoutMs: 30_000 })
  // startsWith so abbreviated CSV SHAs match the full HEAD hash
  return head.exitCode === 0 && head.stdout.trim().startsWith(task.sha.toLowerCase())
}
