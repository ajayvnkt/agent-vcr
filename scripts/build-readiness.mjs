/** Offline build attestation. No model endpoints or sibling repositories are consulted. */
import { createHash } from 'node:crypto'
import { readFile, readdir, mkdir, rename, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = resolve(root, process.argv[2] || 'artifacts/readiness.json')
async function sourceHash() {
  const hash = createHash('sha256')
  const files = ['package.json', 'package-lock.json', 'tsconfig.json']
  async function walk(path) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const next = path + '/' + entry.name
      if (entry.isDirectory()) await walk(next)
      else if (entry.isFile()) files.push(next)
    }
  }
  for (const dir of ['src', 'tests', 'scripts', '.github']) await walk(dir)
  for (const file of files.sort()) hash.update(file + '\0').update(await readFile(join(root, file))).update('\0')
  return hash.digest('hex')
}
await mkdir(resolve(root, 'work'), { recursive: true })
await mkdir(resolve(output, '..'), { recursive: true })
const before = await sourceHash()
const build = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc')], { cwd: root, stdio: 'inherit' })
const testFile = resolve(root, `work/readiness-tests-${process.pid}.json`)
const tests = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=json', '--outputFile=' + testFile], { cwd: root, stdio: 'inherit' })
let results = {}
if (tests.status === 0) results = JSON.parse(await readFile(testFile, 'utf8'))
const after = await sourceHash()
const passed = build.status === 0 && tests.status === 0 && results.success === true &&
  results.numPassedTests > 0 && results.numFailedTests === 0 && before === after
const artifact = {
  schema_version: 1, tool: 'agent-vcr', build_status: passed ? 'PASS' : 'FAIL',
  test_count: results.numPassedTests || 0, source_sha256: after,
  generated_at: new Date().toISOString(),
  capabilities: ['Exact tool-call replay', 'Captured planner routing with immediate divergence refusal',
    'Context token accounting', 'Grounding and compaction evidence'],
  scope: 'Offline build and tests only. No candidate qualification or model evaluation.',
}
await writeFile(output + `.${process.pid}.tmp`, JSON.stringify(artifact, null, 2) + '\n')
await rename(output + `.${process.pid}.tmp`, output)
if (!passed) process.exitCode = 1
