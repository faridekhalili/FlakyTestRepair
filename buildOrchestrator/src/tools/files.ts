import { tool } from '@strands-agents/sdk'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { config } from '../config.js'
import type { BuildTask } from '../types.js'

/**
 * Windowed file reader so the agent can page through big poms and build
 * logs without blowing up its context. Reads are restricted to this task's
 * checkout and the workspace (for log files written by run_command).
 */
export function createReadFileTool(task: BuildTask) {
  return tool({
    name: 'read_file',
    description:
      'Read a slice of a file — project files (relative paths) or command log files (absolute paths ' +
      'returned by run_command). Use startLine/maxLines to page through large files.',
    inputSchema: z.object({
      path: z.string().describe('Path relative to the project root, or an absolute log-file path'),
      startLine: z.number().optional().describe('1-based line to start from (default 1)'),
      maxLines: z.number().optional().describe('Lines to return (default 200, max 500)'),
    }),
    callback: async ({ path: p, startLine, maxLines }) => {
      const resolved = path.isAbsolute(p) ? p : path.resolve(task.dir, p)
      const allowed = resolved.startsWith(task.dir) || resolved.startsWith(config.workspaceDir)
      if (!allowed) throw new Error('Path outside the project checkout and workspace is not readable.')
      if (!fs.existsSync(resolved)) throw new Error(`File not found: ${p}`)

      const lines = fs.readFileSync(resolved, 'utf8').split('\n')
      const start = Math.max(1, startLine ?? 1)
      const count = Math.min(maxLines ?? 200, 500)
      return {
        totalLines: lines.length,
        startLine: start,
        content: lines.slice(start - 1, start - 1 + count).join('\n'),
      }
    },
  })
}
