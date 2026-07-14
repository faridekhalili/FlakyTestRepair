import { config } from '../config.js'
import { prepareRepo } from '../git.js'
import { loadLedger, recordOutcome } from '../ledger.js'
import { createBuildAgent } from '../agents/buildAgent.js'
import { allocateRunLogDir } from '../tools/shell.js'
import type { BuildOutcome, BuildTask } from '../types.js'

export interface RunOptions {
  /** Skip tasks already marked success in the ledger (default true) */
  resume: boolean
  /** How many tasks to process concurrently */
  concurrency: number
}

/**
 * The deterministic driver. For each task:
 *   ledger check → clone/checkout (plain code) → build agent (LLM) → record.
 * The LLM is only in the loop for the genuinely fuzzy step.
 */
export async function runPipeline(tasks: BuildTask[], options: RunOptions): Promise<BuildOutcome[]> {
  const ledger = loadLedger()
  // Tasks of the same project can race in the shared ~/.m2 (e.g. two checkouts
  // running "mvn install" of the same SNAPSHOT version corrupt each other's
  // metadata), so each project's tasks run sequentially inside one worker;
  // only different projects run concurrently.
  const groups = new Map<string, BuildTask[]>()
  for (const task of tasks) {
    const group = groups.get(task.project)
    if (group) group.push(task)
    else groups.set(task.project, [task])
  }
  const groupQueue = [...groups.values()]
  const outcomes: BuildOutcome[] = []
  let done = 0

  async function worker(): Promise<void> {
    while (true) {
      const group = groupQueue.shift()
      if (!group) return
      for (const task of group) {
        await processTask(task)
      }
    }
  }

  async function processTask(task: BuildTask): Promise<void> {
    const position = `[${++done}/${tasks.length}]`
    if (options.resume && ledger[task.id]?.status === 'success') {
      console.log(`${position} ⏭  ${task.project}@${task.sha.slice(0, 7)} — already built, skipping`)
      outcomes.push(ledger[task.id])
      return
    }

    console.log(`${position} ▶  ${task.project}@${task.sha.slice(0, 7)}`)
    const outcome = await runOne(task)
    recordOutcome(task.id, outcome)
    outcomes.push(outcome)

    const icon = outcome.status === 'success' ? '✅' : '❌'
    console.log(
      `${position} ${icon} ${task.project}@${task.sha.slice(0, 7)} — ${outcome.status} ` +
        `(${(outcome.durationMs / 60000).toFixed(1)} min)`,
    )
  }

  const workers = Array.from({ length: Math.max(1, options.concurrency) }, () => worker())
  await Promise.all(workers)
  return outcomes
}

async function runOne(task: BuildTask): Promise<BuildOutcome> {
  const started = Date.now()
  const { logDir, attempt } = allocateRunLogDir(task.id)
  const base = {
    task: { project: task.project, sha: task.sha },
    attempt,
    logDir,
    finishedAt: new Date().toISOString(),
    modelId: config.openRouter.modelId,
  }

  try {
    console.log(`    ⬇ cloning / checking out…${attempt > 1 ? `  (attempt ${attempt})` : ''}`)
    await prepareRepo(task)

    const { runTask } = createBuildAgent(task, logDir)
    const { report, finalText, stoppedEarly, stopReason, tokens, turns } = await runTask()

    if (tokens) {
      console.log(`    ⧗ ${turns} turns, ${(tokens.total / 1000).toFixed(0)}k tokens (${(tokens.input / 1000).toFixed(0)}k in / ${(tokens.output / 1000).toFixed(1)}k out)`)
    }

    if (!report) {
      return {
        ...base,
        status: 'error',
        error: stoppedEarly
          ? `Agent stopped by cost guard (${stopReason}) before reporting.`
          : `Agent finished without calling report_result. Final message: ${finalText.slice(0, 500)}`,
        tokens,
        turns,
        durationMs: Date.now() - started,
        finishedAt: new Date().toISOString(),
      }
    }
    return {
      ...base,
      status: report.status,
      report,
      tokens,
      turns,
      durationMs: Date.now() - started,
      finishedAt: new Date().toISOString(),
    }
  } catch (err) {
    return {
      ...base,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
      finishedAt: new Date().toISOString(),
    }
  }
}
