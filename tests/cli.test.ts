import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'dist', 'cli.js')
const golden = join(root, 'examples', 'minimal', 'traces', 'refund.expected.json')

describe('cli', () => {
  it('validate exits 0 for golden trace', () => {
    const r = spawnSync(process.execPath, [cli, 'validate', golden], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    // New colored CLI outputs "✔ Valid —" (ANSI stripped in non-TTY)
    expect(r.stderr).toMatch(/Valid|OK/i)
  })

  it('diff exits 0 for identical files', () => {
    const r = spawnSync(process.execPath, [cli, 'diff', golden, golden], { encoding: 'utf8' })
    expect(r.status).toBe(0)
  })

  it('diff exits non-zero on mismatch', () => {
    const bad = join(root, 'tests', 'fixtures', 'bad-actual.json')
    const r = spawnSync(process.execPath, [cli, 'diff', golden, bad], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/DIFF|mismatch|differs|length/i)
  })

  it('diff subsequence mismatch prints trace lists not index-aligned grid', () => {
    const bad = join(root, 'tests', 'fixtures', 'bad-actual.json')
    const r = spawnSync(process.execPath, [cli, 'diff', golden, bad, '--mode', 'subsequence'], {
      encoding: 'utf8',
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/subsequence/i)
    expect(r.stderr).toMatch(/expected →|actual →/i)
  })
})
