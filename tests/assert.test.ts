import { describe, expect, it } from 'vitest'

import { assertTrace, callMatches, checkArg, traceSatisfies } from '../src/assert.js'
import { addVariant, matchVariants, proposeVariants } from '../src/variants.js'
import type { ToolCallRecord } from '../src/types.js'

const c = (name: string, args: Record<string, unknown> = {}): ToolCallRecord => ({ name, args })

const refundTrace = [
  c('lookup_order', { orderId: '123' }),
  c('verify_order', { orderId: '123' }),
  c('refund_order', { orderId: '123', amount: 10 }),
]

describe('checkArg', () => {
  it('treats a bare value as equality', () => {
    expect(checkArg('a', 1, 1)).toBeNull()
    expect(checkArg('a', 1, 2)).toMatch(/expected 2, got 1/)
  })

  it('compares objects structurally regardless of key order', () => {
    expect(checkArg('a', { x: 1, y: 2 }, { equals: { y: 2, x: 1 } })).toBeNull()
  })

  it('supports oneOf, contains, matches, exists and absent', () => {
    expect(checkArg('s', 'high', { oneOf: ['low', 'high'] })).toBeNull()
    expect(checkArg('s', 'mid', { oneOf: ['low', 'high'] })).toMatch(/expected one of/)
    expect(checkArg('s', 'order-123', { contains: '123' })).toBeNull()
    expect(checkArg('s', 'order-123', { matches: '^order-\\d+$' })).toBeNull()
    expect(checkArg('s', 'nope', { matches: '^order-\\d+$' })).toMatch(/to match/)
    expect(checkArg('s', undefined, { exists: true })).toMatch(/to be present/)
    expect(checkArg('s', 'x', { absent: true })).toMatch(/to be absent/)
    expect(checkArg('s', undefined, { absent: true })).toBeNull()
  })

  it('reports an invalid regex instead of throwing', () => {
    expect(checkArg('s', 'x', { matches: '([' })).toMatch(/invalid regex/)
  })

  it('truncates long values in messages', () => {
    const long = 'y'.repeat(500)
    const msg = checkArg('s', long, 'x')!
    expect(msg.length).toBeLessThan(300)
    expect(msg).toContain('...')
  })
})

describe('callMatches', () => {
  it('matches on name alone when given a string', () => {
    expect(callMatches(c('refund_order', { amount: 10 }), 'refund_order')).toBe(true)
    expect(callMatches(c('refund_order'), 'lookup_order')).toBe(false)
  })

  it('ignores arguments the pattern does not mention', () => {
    expect(callMatches(c('refund', { a: 1, b: 2 }), { name: 'refund', args: { a: 1 } })).toBe(true)
  })

  it('fails when a named argument does not match', () => {
    expect(callMatches(c('refund', { a: 1 }), { name: 'refund', args: { a: 99 } })).toBe(false)
  })
})

describe('assertTrace', () => {
  it('passes a compliant trace', () => {
    expect(
      traceSatisfies(refundTrace, {
        sequence: ['lookup_order', 'refund_order'],
        forbid: ['delete_account'],
        ordering: [['verify_order', 'refund_order']],
        maxCalls: 5,
      }),
    ).toBe(true)
  })

  it('allows unrelated calls between sequence entries', () => {
    const withExtras = [c('lookup_order'), c('log'), c('metrics'), c('refund_order')]
    expect(traceSatisfies(withExtras, { sequence: ['lookup_order', 'refund_order'] })).toBe(true)
  })

  it('catches a forbidden tool and reports where', () => {
    const f = assertTrace([c('a'), c('drop_table')], { forbid: ['drop_table'] })
    expect(f).toHaveLength(1)
    expect(f[0]!.kind).toBe('forbidden')
    expect(f[0]!.index).toBe(1)
  })

  it('catches a violated partial order', () => {
    const bad = [c('refund_order'), c('verify_order')]
    const f = assertTrace(bad, { ordering: [['verify_order', 'refund_order']] })
    expect(f[0]!.kind).toBe('ordering')
    expect(f[0]!.message).toMatch(/must precede/)
  })

  it('ignores an ordering rule when one of the tools never appears', () => {
    expect(assertTrace([c('a')], { ordering: [['verify_order', 'refund_order']] })).toEqual([])
  })

  it('requires: fails a refund with no verification at all — where ordering passes', () => {
    const unsafe = [c('lookup_order'), c('refund_order')]
    // This is the gap: ordering is vacuously true when the prerequisite is absent.
    expect(assertTrace(unsafe, { ordering: [['verify_order', 'refund_order']] })).toEqual([])
    const f = assertTrace(unsafe, { requires: [['refund_order', 'verify_order']] })
    expect(f).toHaveLength(1)
    expect(f[0]!.kind).toBe('requires')
    expect(f[0]!.message).toMatch(/never called/)
  })

  it('requires: fails when the prerequisite only happens afterwards', () => {
    const f = assertTrace([c('refund_order'), c('verify_order')], {
      requires: [['refund_order', 'verify_order']],
    })
    expect(f[0]!.kind).toBe('requires')
    expect(f[0]!.message).toMatch(/only happened at index 1/)
  })

  it('requires: passes when the prerequisite precedes every dependent call', () => {
    expect(
      assertTrace([c('verify_order'), c('refund_order'), c('refund_order')], {
        requires: [['refund_order', 'verify_order']],
      }),
    ).toEqual([])
  })

  it('requires: reports a dependent call once, not once per occurrence', () => {
    const f = assertTrace([c('refund_order'), c('refund_order')], {
      requires: [['refund_order', 'verify_order']],
    })
    expect(f).toHaveLength(1)
    expect(f[0]!.index).toBe(0)
  })

  it('flags runaway loops via maxCalls and maxCallsPerTool', () => {
    const spam = Array.from({ length: 9 }, () => c('search'))
    expect(assertTrace(spam, { maxCalls: 5 })[0]!.kind).toBe('maxCalls')
    expect(assertTrace(spam, { maxCallsPerTool: 3 })[0]!.kind).toBe('maxCallsPerTool')
  })

  it('names the wrong argument rather than reporting the tool as missing', () => {
    const f = assertTrace([c('refund_order', { amount: 9999 })], {
      includes: [{ name: 'refund_order', args: { amount: 10 } }],
    })
    expect(f[0]!.kind).toBe('args')
    expect(f[0]!.message).toMatch(/"refund_order" was called but/)
    expect(f[0]!.message).toMatch(/amount/)
  })

  it('reports a genuinely missing tool as missing', () => {
    const f = assertTrace([c('lookup_order')], { includes: ['refund_order'] })
    expect(f[0]!.kind).toBe('missing')
  })

  it('returns every failure, not just the first', () => {
    const f = assertTrace([c('refund_order'), c('drop_table')], {
      forbid: ['drop_table'],
      includes: ['lookup_order'],
      maxCalls: 1,
    })
    expect(f.length).toBeGreaterThanOrEqual(3)
    expect(new Set(f.map((x) => x.kind))).toEqual(new Set(['maxCalls', 'forbidden', 'missing']))
  })

  it('treats an empty assertion as always satisfied', () => {
    expect(assertTrace(refundTrace, {})).toEqual([])
  })
})

describe('matchVariants', () => {
  const variants = [
    { name: 'cache-miss', calls: [c('lookup'), c('fetch'), c('reply')] },
    { name: 'cache-hit', calls: [c('lookup'), c('reply')] },
  ]

  it('matches an accepted path by name', () => {
    const r = matchVariants([c('lookup'), c('reply')], variants)
    expect(r.matched).toBe(true)
    expect(r.variant).toBe('cache-hit')
  })

  it('reports the closest path and where it diverged', () => {
    const r = matchVariants([c('lookup'), c('fetch'), c('explode')], variants)
    expect(r.matched).toBe(false)
    expect(r.closest?.variant).toBe('cache-miss')
    expect(r.closest?.divergedAt).toBe(2)
    expect(r.message).toMatch(/diverged at call 2/)
  })

  it('prefers the deepest divergence as closest, not the shortest path', () => {
    const r = matchVariants([c('lookup'), c('fetch'), c('wrong')], variants)
    expect(r.closest?.variant).toBe('cache-miss')
  })

  it('throws on an empty variant set', () => {
    expect(() => matchVariants([c('a')], [])).toThrow(/no variants/)
  })
})

describe('addVariant', () => {
  const base = [{ name: 'happy', calls: [c('a'), c('b')] }]

  it('adds a genuinely new path', () => {
    const r = addVariant(base, [c('a'), c('c')], 'retry')
    expect(r.added).toBe(true)
    expect(r.variants).toHaveLength(2)
  })

  it('refuses a path already covered', () => {
    const r = addVariant(base, [c('a'), c('b')], 'dup')
    expect(r.added).toBe(false)
    expect(r.reason).toMatch(/already covered/)
    expect(r.variants).toHaveLength(1)
  })

  it('rejects a duplicate name', () => {
    expect(() => addVariant(base, [c('z')], 'happy')).toThrow(/already exists/)
  })
})

describe('proposeVariants', () => {
  it('ranks observed paths by frequency', () => {
    const runs = [
      [c('a'), c('b')],
      [c('a'), c('b')],
      [c('a'), c('c')],
    ]
    const p = proposeVariants(runs)
    expect(p).toHaveLength(2)
    expect(p[0]!.count).toBe(2)
    expect(p[0]!.share).toBeCloseTo(2 / 3)
    expect(p[1]!.count).toBe(1)
  })

  it('distinguishes paths that differ only in arguments', () => {
    const p = proposeVariants([[c('refund', { amount: 10 })], [c('refund', { amount: 20 })]])
    expect(p).toHaveLength(2)
  })
})
