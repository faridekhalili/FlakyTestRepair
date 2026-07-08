import { tool } from '@strands-agents/sdk'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { runShell, SDKMAN_DIR } from '../exec.js'

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

function sdk(command: string, timeoutMs = INSTALL_TIMEOUT_MS) {
  return runShell(`source "${SDKMAN_DIR}/bin/sdkman-init.sh" && ${command}`, { timeoutMs })
}

function installedVersions(candidate: string): string[] {
  const dir = path.join(SDKMAN_DIR, 'candidates', candidate)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((v) => v !== 'current')
}

/** What JDKs / build tools are already installed via SDKMAN. */
export const listToolchains = tool({
  name: 'list_toolchains',
  description:
    'List the JDK, Maven, and Gradle versions already installed via SDKMAN. ' +
    'Java version ids look like "8.0.472-amzn" or "11.0.31-tem".',
  inputSchema: z.object({}),
  callback: async () => ({
    java: installedVersions('java'),
    maven: installedVersions('maven'),
    gradle: installedVersions('gradle'),
  }),
})

/** Search what's installable, so the agent picks a real version id. */
export const searchJavaVersions = tool({
  name: 'search_java_versions',
  description:
    'Search SDKMAN for installable JDK version ids matching a major version (e.g. 8, 11, 17, 21). ' +
    'Returns exact ids usable with install_toolchain, best vendor first. ' +
    'Note: not every vendor ships every major version; always pick from this list.',
  inputSchema: z.object({
    majorVersion: z.number().describe('Java major version, e.g. 8, 11, 17, 21'),
  }),
  callback: async ({ majorVersion }) => {
    const result = await sdk(`sdk list java | tr '|' '\\n' | tr -d ' ' | grep -E '^${majorVersion}\\.[0-9.]+' | sort -u`)
    const ids = result.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    // Prefer well-known, license-friendly vendors; SDKMAN drops old majors
    // for some vendors (e.g. no Temurin 8), so fall through in order.
    const vendorRank = ['-tem', '-zulu', '-librca', '-amzn', '-kona', '-ms', '-sem']
    const ranked = ids
      .filter((id) => !id.includes('.fx')) // JavaFX bundles are never needed here
      .sort((a, b) => {
        const rank = (id: string) => {
          const i = vendorRank.findIndex((v) => id.endsWith(v))
          return i === -1 ? vendorRank.length : i
        }
        return rank(a) - rank(b)
      })
    return { versionIds: ranked.slice(0, 8) }
  },
})

/** Install a JDK / Maven / Gradle version on demand. */
export const installToolchain = tool({
  name: 'install_toolchain',
  description:
    'Install a specific JDK, Maven, or Gradle version via SDKMAN. ' +
    'For java, use an exact id from search_java_versions (e.g. "8.0.442-tem"). ' +
    'For maven/gradle, a plain version like "3.9.6" or omit version for the latest.',
  inputSchema: z.object({
    candidate: z.enum(['java', 'maven', 'gradle']),
    version: z.string().optional().describe('Exact version id; omit for latest stable'),
  }),
  callback: async ({ candidate, version }) => {
    console.log(`    ⚙ sdk install ${candidate} ${version ?? '(latest)'}`)
    const result = await sdk(`sdk install ${candidate} ${version ?? ''} <<< ""`)
    const ok = result.exitCode === 0 || /is already installed/.test(result.stdout)
    return {
      ok,
      installed: installedVersions(candidate),
      output: result.stdout.slice(-1500),
    }
  },
})
