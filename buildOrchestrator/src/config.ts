import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`)
  }
  return value
}

export const config = {
  packageRoot,

  openRouter: {
    apiKey: requireEnv('OPENROUTER_API_KEY'),
    modelId: process.env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4.5',
    baseURL: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    maxTokens: Number(process.env.MODEL_MAX_TOKENS ?? 4096),
  },

  /** Root for clones, per-task logs, and the ledger. */
  workspaceDir: path.resolve(packageRoot, process.env.WORKSPACE_DIR ?? 'workspace'),

  commandTimeoutMs: Number(process.env.COMMAND_TIMEOUT_SECONDS ?? 1800) * 1000,
  logTailChars: Number(process.env.LOG_TAIL_CHARS ?? 5000),

  /** Hard wall-clock cap per task — bounds provider-retry death spirals.
   *  Generous: big trees (nifi, cxf) legitimately need 25+ min of Maven time;
   *  runaway cost is already bounded by the token and turn caps. */
  taskTimeoutMs: Number(process.env.TASK_TIMEOUT_MINUTES ?? 45) * 60 * 1000,
  /** Cumulative token cap per task (input+output across all model calls). */
  taskTokenBudget: Number(process.env.TASK_TOKEN_BUDGET ?? 1_500_000),
  /** Max agent loop turns per task. */
  taskMaxTurns: Number(process.env.TASK_MAX_TURNS ?? 40),

  csvPath: path.resolve(packageRoot, 'integration_tests_flakies.csv'),
} as const

export const paths = {
  repos: path.join(config.workspaceDir, 'repos'),
  logs: path.join(config.workspaceDir, 'logs'),
  ledger: path.join(config.workspaceDir, 'ledger.json'),
} as const
