import { describe, it, expect } from 'vitest'
import { compareTraces } from '../src/diff.js'
import type { ToolCallRecord } from '../src/types.js'

describe('compareTraces exact', () => {
  it('accepts identical sequences', () => {
    const c: ToolCallRecord[] = [
      { name: 'a', args: { x: 1 } },
      { name: 'b', args: { y: 'z' } },
    ]
    expect(compareTraces(c, c)).toEqual({ ok: true })
  })

  it('rejects length mismatch', () => {
    const a: ToolCallRecord[] = [{ name: 'a', args: {} }]
    const b: ToolCallRecord[] = []
    const r = compareTraces(a, b)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('length')
  })

  it('rejects name mismatch', () => {
    const e: ToolCallRecord[] = [{ name: 'a', args: {} }]
    const x: ToolCallRecord[] = [{ name: 'b', args: {} }]
    const r = compareTraces(e, x)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.index).toBe(0)
  })

  it('treats arg key order as equivalent', () => {
    const e: ToolCallRecord[] = [{ name: 'a', args: { x: 1, y: 2 } }]
    const a: ToolCallRecord[] = [{ name: 'a', args: { y: 2, x: 1 } }]
    expect(compareTraces(e, a)).toEqual({ ok: true })
  })
})

describe('compareTraces subsequence', () => {
  it('allows extra calls between expected', () => {
    const e: ToolCallRecord[] = [
      { name: 'a', args: {} },
      { name: 'b', args: {} },
    ]
    const a: ToolCallRecord[] = [
      { name: 'noise', args: {} },
      { name: 'a', args: {} },
      { name: 'x', args: {} },
      { name: 'b', args: {} },
    ]
    expect(compareTraces(e, a, { mode: 'subsequence' })).toEqual({ ok: true })
  })

  it('fails when expected call missing', () => {
    const e: ToolCallRecord[] = [{ name: 'a', args: {} }, { name: 'c', args: {} }]
    const a: ToolCallRecord[] = [{ name: 'a', args: {} }, { name: 'b', args: {} }]
    const r = compareTraces(e, a, { mode: 'subsequence' })
    expect(r.ok).toBe(false)
  })
})
