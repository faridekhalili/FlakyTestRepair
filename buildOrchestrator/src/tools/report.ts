import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import type { AgentReport } from '../types.js'

/**
 * Structured hand-off from the agent back to the orchestrator.
 * Instead of parsing the agent's prose, we require it to call this tool
 * exactly once; the closure captures the payload for the pipeline.
 */
export function createReportTool() {
  let report: AgentReport | undefined

  const reportResult = tool({
    name: 'report_result',
    description:
      'REQUIRED final step: report the build outcome for this project. Call exactly once, ' +
      'after you have either verified the build or exhausted your attempts.',
    inputSchema: z.object({
      status: z.enum(['success', 'failure']),
      buildTool: z.enum(['maven', 'gradle', 'other']),
      jdkVersion: z.string().describe('SDKMAN java id that worked (or was last tried), e.g. "8.0.472-amzn"'),
      testCompileCommand: z
        .string()
        .describe('The exact command that compiles main + test sources, e.g. "./mvnw -B test-compile"'),
      notes: z
        .string()
        .describe('Brief summary: what was needed, any fixes applied, or why it failed'),
    }),
    callback: async (input) => {
      report = input
      return { recorded: true }
    },
  })

  return { reportResult, getReport: () => report }
}
