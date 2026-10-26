import { expect, it } from 'vitest'
import { diffContext } from '../src/context-diff.js'

it('counts actual supplied token IDs per changed component, including additions and deletions', () => {
  const table: Record<string, number[]> = { 'long text': [4, 5, 6], short: [8], same: [9, 10],
    old: [11], new: [12, 13], '': [] }
  const result = diffContext({ system: 'long text', retained: 'same', removed: 'old' },
    { system: 'short', retained: 'same', added: 'new' },
    { tokenizerId: 'known-token-table-v1', encode: text => table[text]! })
  expect(result.sumComponentTokensBefore).toBe(6)
  expect(result.sumComponentTokensAfter).toBe(5)
  expect(result.tokenDelta).toBe(-1)
  expect(result.components.map(c => [c.component, c.change, c.tokenDelta])).toEqual([
    ['added', 'added', 2], ['removed', 'removed', -1], ['system', 'changed', -2],
  ])
  expect(result.components[2]!.before).toBe('long text')
  expect(result.components[2]!.after).toBe('short')
  expect(JSON.stringify(result)).not.toContain('savings')
})

it('does not substitute a character estimate or accept invalid tokens', () => {
  expect(() => diffContext({ x: 'text' }, {}, { tokenizerId: '', encode: () => [] })).toThrow()
  expect(() => diffContext({ x: 'text' }, {}, { tokenizerId: 'v1', encode: () => [-1] })).toThrow()
  expect(() => diffContext({ x: 'text' }, {}, { tokenizerId: 'v1', encode: () => [NaN] })).toThrow()
  expect(diffContext({}, { x: '' }, { tokenizerId: 'v1', encode: () => new Uint32Array() })
    .components[0]!.change).toBe('added')
})
