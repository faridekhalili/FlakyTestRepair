/** One row of integration_tests_flakies.csv, enriched with derived paths. */
export interface BuildTask {
  /** e.g. "alibaba/fastjson" */
  project: string
  /** Full commit SHA to check out */
  sha: string
  /** Stable unique id: "<owner>__<repo>__<sha7>" — used for dirs, logs, ledger keys */
  id: string
  /** e.g. "https://github.com/alibaba/fastjson.git" */
  repoUrl: string
  /** Absolute path of the checkout for this (project, sha) */
  dir: string
}

export type BuildStatus = 'success' | 'failure' | 'error' | 'skipped'

/** Structured outcome the agent reports via the report_result tool. */
export interface AgentReport {
  status: 'success' | 'failure'
  buildTool: 'maven' | 'gradle' | 'other'
  jdkVersion: string
  /** The exact command that compiles main + test sources for this project */
  testCompileCommand: string
  /** What was tried, what failed, what fixed it — for humans reading the ledger */
  notes: string
}

/** Ledger entry: agent report + orchestrator bookkeeping. */
export interface BuildOutcome {
  task: { project: string; sha: string }
  status: BuildStatus
  report?: AgentReport
  /** Populated when status is "error" (agent crashed / never reported) */
  error?: string
  /** How many runs this task has had (this outcome is from the latest) */
  attempt: number
  /** Token usage of this run (input+output across all model calls) */
  tokens?: { input: number; output: number; total: number }
  /** Number of agent loop turns this run used */
  turns?: number
  /** Where this run's command logs live (workspace/logs/<task-id>/run-NNN) */
  logDir: string
  durationMs: number
  finishedAt: string
  modelId: string
}

export type Ledger = Record<string, BuildOutcome>
