import { tool } from '@strands-agents/sdk'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { BuildTask } from '../types.js'

function exists(dir: string, rel: string): boolean {
  return fs.existsSync(path.join(dir, rel))
}

function grepFile(dir: string, rel: string, patterns: RegExp[]): string[] {
  const file = path.join(dir, rel)
  if (!fs.existsSync(file)) return []
  const content = fs.readFileSync(file, 'utf8')
  const hits: string[] = []
  for (const line of content.split('\n')) {
    if (patterns.some((p) => p.test(line))) hits.push(line.trim())
  }
  return hits.slice(0, 20)
}

/**
 * One-shot deterministic scan of the checkout so the agent starts with the
 * facts it needs (build system, wrappers, JDK hints) instead of spending
 * turns running ls/cat.
 */
export function createInspectTool(task: BuildTask) {
  return tool({
    name: 'inspect_project',
    description:
      'Scan the project checkout: detects Maven/Gradle, wrapper scripts, CI config, and Java version ' +
      'hints from build files. Call this first.',
    inputSchema: z.object({}),
    callback: async () => {
      const dir = task.dir
      const javaHintPatterns = [
        /maven\.compiler\.(source|target|release)/,
        /<java\.version>/,
        /<(source|target|release)>\s*\d/,
        /sourceCompatibility|targetCompatibility|JavaVersion\./,
        /languageVersion/,
      ]

      const gradleWrapperProps = 'gradle/wrapper/gradle-wrapper.properties'
      const mavenWrapperProps = '.mvn/wrapper/maven-wrapper.properties'

      return {
        project: task.project,
        sha: task.sha,
        buildFiles: {
          'pom.xml': exists(dir, 'pom.xml'),
          'build.gradle': exists(dir, 'build.gradle'),
          'build.gradle.kts': exists(dir, 'build.gradle.kts'),
          'settings.gradle': exists(dir, 'settings.gradle') || exists(dir, 'settings.gradle.kts'),
          mvnw: exists(dir, 'mvnw'),
          gradlew: exists(dir, 'gradlew'),
        },
        wrapperVersions: {
          maven: grepFile(dir, mavenWrapperProps, [/distributionUrl/]),
          gradle: grepFile(dir, gradleWrapperProps, [/distributionUrl/]),
        },
        javaVersionHints: {
          'pom.xml': grepFile(dir, 'pom.xml', javaHintPatterns),
          'build.gradle': grepFile(dir, 'build.gradle', javaHintPatterns),
          'build.gradle.kts': grepFile(dir, 'build.gradle.kts', javaHintPatterns),
        },
        ciConfig: {
          '.github/workflows': exists(dir, '.github/workflows'),
          '.travis.yml': exists(dir, '.travis.yml'),
        },
        topLevelEntries: fs.readdirSync(dir).filter((e) => e !== '.git').slice(0, 40),
      }
    },
  })
}
