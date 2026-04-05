import { describe, it, expect } from 'vitest'
import { parseTraceFileV1, safeParseTraceFileV1 } from '../src/schema.js'

describe('traceFileV1Schema', () => {
  it('parses minimal valid trace', () => {
    const v = parseTraceFileV1({ version: 1, calls: [{ name: 't', args: {} }] })
    expect(v.calls).toHaveLength(1)
    expect(v.calls[0]!.name).toBe('t')
  })

  it('defaults args to {}', () => {
    const v = parseTraceFileV1({ version: 1, calls: [{ name: 't' }] })
    expect(v.calls[0]!.args).toEqual({})
  })

  it('rejects wrong version', () => {
    expect(() => parseTraceFileV1({ version: 2, calls: [] })).toThrow()
  })

  it('safeParse returns error object', () => {
    const r = safeParseTraceFileV1({ version: 1, calls: [{ name: '' }] })
    expect(r.success).toBe(false)
  })
})
