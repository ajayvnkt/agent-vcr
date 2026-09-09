import { describe, it, expect } from 'vitest'
import { assertGrounding, assertTransformationSurvival, assertTrace } from '../src/index.js'

const calls = [{ name: 'reserve', args: { item: 'BOOK-7', count: 2 } },
  { name: 'reserve', args: { item: 'BOOK-8', count: 2 } }]
const sources = [{ id: 'request', kind: 'user' as const, text: 'Reserve BOOK-7', availableBefore: 0 }]
const rules = [{ tool: 'reserve', arguments: ['item'] }]

describe('argument grounding', () => {
  it('checks every invocation and refuses implied arguments', () => {
    const citations = [{ call: 0, argument: 'item', source: 'request', span: [8, 14] as [number, number] }]
    const failures = assertGrounding(calls, rules, sources, citations)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.index).toBe(1)
    expect(assertTrace(calls, { grounding: { rules, sources, citations } })).toEqual(failures)
  })
  it('rejects future state and missing evidence', () => {
    expect(assertGrounding(calls.slice(0, 1), rules,
      [{ id: 's', kind: 'state', value: { item: 'BOOK-7' }, availableBefore: 1 }],
      [{ call: 0, argument: 'item', source: 's', path: 'item' }])).toHaveLength(1)
  })
  it('accepts typed state values, rejects numeric substring cherry picking', () => {
    const cs = [{ name: 'reserve', args: { count: 2 } }]
    const rs = [{ tool: 'reserve', arguments: ['count'] }]
    expect(assertGrounding(cs, rs, [{ id: 's', kind: 'state', value: 2, availableBefore: 0 }],
      [{ call: 0, argument: 'count', source: 's' }])).toEqual([])
    expect(assertGrounding(cs, rs, [{ id: 'u', kind: 'user', text: '12', availableBefore: 0 }],
      [{ call: 0, argument: 'count', source: 'u', span: [1, 2] }])).toHaveLength(1)
  })
})

describe('transformation survival', () => {
  const rs = [{ id: 'owner', fact: 'external actor', neededBy: 'review' }]
  const cs = [{ name: 'review', args: {} }]
  it('catches a sanitizer that removes a downstream signal', () => {
    expect(assertTransformationSurvival(cs,
      [{ id: 'q', kind: 'sanitize', atCall: 0, before: 'external actor with noisy text', after: 'clean text' }], rs)).toHaveLength(1)
  })
  it('accepts preserved facts and checks every later cut', () => {
    const e = { id: 'q', kind: 'sanitize' as const, atCall: 0, before: 'external actor', after: 'external actor' }
    expect(assertTransformationSurvival(cs, [e], rs)).toEqual([])
    expect(assertTransformationSurvival(cs, [e, { ...e, id: 'c', kind: 'compact', after: 'clean' }], rs)).toHaveLength(1)
  })
  it('does not pass an unexercised contract or absent prior evidence', () => {
    expect(assertTransformationSurvival(cs, [], rs)).toHaveLength(1)
    expect(assertTransformationSurvival(cs, [{ id: 'q', kind: 'summarize', atCall: 0, before: '', after: 'external actor' }], rs)).toHaveLength(1)
  })
})
