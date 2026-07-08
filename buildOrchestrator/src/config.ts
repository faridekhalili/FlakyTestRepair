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
  logTailChars: Number(process.env.LOG_TAIL_CHARS ?? 12000),

  csvPath: path.resolve(packageRoot, 'integration_tests_flakies.csv'),
} as const

export const paths = {
  repos: path.join(config.workspaceDir, 'repos'),
  logs: path.join(config.workspaceDir, 'logs'),
  ledger: path.join(config.workspaceDir, 'ledger.json'),
} as const
