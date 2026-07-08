import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { config } from './config.js'
import { loadTasks } from './csv.js'
import { SDKMAN_DIR } from './exec.js'
import { runPipeline } from './pipeline/orchestrator.js'

const { values } = parseArgs({
  options: {
    limit: { type: 'string' },
    filter: { type: 'string' },
    only: { type: 'string' },
    concurrency: { type: 'string', default: '1' },
    fresh: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  console.log(`
Usage: npm run dev -- [options]

Options:
  --limit <n>        Only process the first n matching tasks
  --filter <str>     Only tasks whose project name contains <str> (e.g. --filter fastjson)
  --only <id>        Run one task by id (e.g. alibaba__fastjson__37ed66b)
  --concurrency <n>  Parallel builds (default 1)
  --fresh            Ignore the ledger; rebuild even previously-successful tasks
  --dry-run          List the tasks that would run, then exit
`)
  process.exit(0)
}

if (!values['dry-run'] && !fs.existsSync(SDKMAN_DIR)) {
  console.error('SDKMAN is not installed. Run "npm run bootstrap" first.')
  process.exit(1)
}

let tasks = loadTasks(config.csvPath)
if (values.filter) tasks = tasks.filter((t) => t.project.includes(values.filter!))
if (values.only) tasks = tasks.filter((t) => t.id === values.only)
if (values.limit) tasks = tasks.slice(0, Number(values.limit))

console.log(`Model: ${config.openRouter.modelId}  |  Tasks: ${tasks.length}  |  Workspace: ${config.workspaceDir}\n`)

if (values['dry-run']) {
  for (const t of tasks) console.log(`  ${t.id}`)
  process.exit(0)
}

const outcomes = await runPipeline(tasks, {
  resume: !values.fresh,
  concurrency: Number(values.concurrency),
})

const byStatus = (s: string) => outcomes.filter((o) => o.status === s).length
console.log(`
==== Summary ====
  success: ${byStatus('success')}
  failure: ${byStatus('failure')}
  error:   ${byStatus('error')}
  total:   ${outcomes.length}

Details in workspace/ledger.json; per-command logs in workspace/logs/<task-id>/.
`)
