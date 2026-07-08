import fs from 'node:fs'
import path from 'node:path'
import { paths } from './config.js'
import type { BuildTask } from './types.js'

/**
 * Parses integration_tests_flakies.csv (header: project,sha) into BuildTasks.
 * The same project can appear with several SHAs; each pair gets its own
 * checkout directory so builds never interfere.
 */
export function loadTasks(csvPath: string): BuildTask[] {
  const raw = fs.readFileSync(csvPath, 'utf8')
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)

  const [header, ...rows] = lines
  if (header?.toLowerCase() !== 'project,sha') {
    throw new Error(`Unexpected CSV header "${header}" in ${csvPath} — expected "project,sha"`)
  }

  return rows.map((line, i) => {
    const [project, sha] = line.split(',').map((s) => s.trim())
    if (!project || !sha || !project.includes('/')) {
      throw new Error(`Malformed CSV row ${i + 2}: "${line}"`)
    }
    const id = `${project.replace('/', '__')}__${sha.slice(0, 7)}`
    return {
      project,
      sha,
      id,
      repoUrl: `https://github.com/${project}.git`,
      dir: path.join(paths.repos, id),
    }
  })
}
