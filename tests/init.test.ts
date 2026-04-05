import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initProject } from '../src/init.js'

describe('initProject', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-vcr-init-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates traces, sample test, and record.config.json', async () => {
    const result = await initProject({ dir })
    expect(result.created).toEqual(
      expect.arrayContaining([
        'traces/example.expected.json',
        'tests/example.vcr.test.ts',
        'record.config.json',
      ]),
    )
    expect(result.skipped).toEqual([])

    const golden = await readFile(join(dir, 'traces/example.expected.json'), 'utf8')
    expect(golden).toContain('"version": 1')
    expect(golden).toContain('lookup_order')

    const testFile = await readFile(join(dir, 'tests/example.vcr.test.ts'), 'utf8')
    expect(testFile).toContain('agent-vcr')
    expect(testFile).toContain('loadTraceFile')

    const cfg = await readFile(join(dir, 'record.config.json'), 'utf8')
    expect(cfg).toContain('agent-vcr record')
    expect(cfg).toContain('process_refund')
  })

  it('throws when files exist and skipExisting is false', async () => {
    await initProject({ dir })
    await expect(initProject({ dir })).rejects.toThrow(/already exists/)
  })

  it('skips existing files when skipExisting is true', async () => {
    await initProject({ dir })
    const again = await initProject({ dir, skipExisting: true })
    expect(again.created).toEqual([])
    expect(again.skipped.length).toBe(3)
  })
})
