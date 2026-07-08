import fs from 'node:fs'
import path from 'node:path'
import { paths } from './config.js'
import type { BuildOutcome, Ledger } from './types.js'

/**
 * Persistent record of every attempt, keyed by task id.
 * Lets a run be interrupted and resumed: tasks already marked "success"
 * are skipped unless --fresh is passed.
 */
export function loadLedger(): Ledger {
  if (!fs.existsSync(paths.ledger)) return {}
  return JSON.parse(fs.readFileSync(paths.ledger, 'utf8')) as Ledger
}

export function recordOutcome(taskId: string, outcome: BuildOutcome): void {
  const ledger = loadLedger()
  ledger[taskId] = outcome
  fs.mkdirSync(path.dirname(paths.ledger), { recursive: true })
  fs.writeFileSync(paths.ledger, JSON.stringify(ledger, null, 2))
}
