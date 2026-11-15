/**
 * Regression tests for defects found in review of the live behaviour layer.
 * Each one is a way the check could have reported a pass it had not earned.
 */
import { describe, it, expect } from 'vitest'
import { classifyBehavior, classifyRun, policyHasRules } from '../src/behavior.js'
import { formatBehaviorMarkdown } from '../src/behavior-report.js'
import { parsePolicyFile } from '../src/behavior-io.js'
import { traceFromMessages } from '../src/adapters/langgraph.js'
import { recordTrace } from '../src/record.js'
import type { ToolCallRecord } from '../src/types.js'

const lookup: ToolCallRecord = { name: 'lookup_order', args: { orderId: '4471' } }
const refund: ToolCallRecord = { name: 'refund_order', args: { orderId: '4471', amount: 40 } }
const del: ToolCallRecord = { name: 'delete_account', args: {} }

describe('subsequence mode', () => {
  it('refuses an empty golden trace, which every run would match', () => {
    expect(() => classifyRun([del], { golden: [], mode: 'subsequence' })).toThrow(/empty golden trace/)
    expect(classifyRun([], { golden: [] }).class).toBe('golden')
  })

  it('says a run with extra calls contains the golden trace and reports no divergence for it', () => {
    const r = classifyRun([lookup, del, refund], { golden: [lookup, refund], mode: 'subsequence' })
    expect(r.class).toBe('golden')
    expect(r.reason).toMatch(/contains the golden trace/)
    expect(r.divergence).toBeNull()
  })

  it('still lets policy catch the extra call', () => {
    const r = classifyRun([lookup, del, refund], { golden: [lookup, refund], mode: 'subsequence', policy: { forbid: ['delete_account'] } })
    expect(r.class).toBe('regression')
    expect(r.divergence).toEqual({ index: 1, expected: refund, actual: del })
  })
})

describe('policies that enforce nothing', () => {
  it('does not count an empty policy as a policy', () => {
    expect(policyHasRules(undefined)).toBe(false)
    expect(policyHasRules({})).toBe(false)
    expect(policyHasRules({ forbid: [], requires: [] })).toBe(false)
    expect(policyHasRules({ maxCalls: 0 })).toBe(true)
    const r = classifyBehavior([{ calls: [del] }], { golden: [lookup], policy: { forbid: [] } })
    expect(r.hasPolicy).toBe(false)
    expect(r.summary).not.toMatch(/No stated policy was broken/)
    expect(r.summary).toMatch(/No policy rules were supplied/)
    expect(formatBehaviorMarkdown(r)).toMatch(/not checked \(no policy\)/)
  })

  it('refuses a policy file with no rules', () => {
    expect(() => parsePolicyFile({})).toThrow(/no rules/)
    expect(() => parsePolicyFile({ forbid: [] })).toThrow(/no rules/)
  })

  it('refuses typos inside a pattern, which would silently match everything', () => {
    expect(() => parsePolicyFile({ includes: [{ name: 'refund_order', arg: { amount: 1 } }] })).toThrow(/unknown key "arg"/)
    expect(() => parsePolicyFile({ sequence: [{ name: 'a', args: 'x' }] })).toThrow(/"args" must be an object/)
    expect(() => parsePolicyFile({ includes: [{ name: 'a', args: { id: { Equals: 1 } } }] })).toThrow(/unknown matcher "Equals"/)
    expect(() => parsePolicyFile({ includes: [{ name: 'a', args: { id: { matches: '(' } } }] })).toThrow(/valid regular expression/)
    expect(parsePolicyFile({ includes: [{ name: 'a', args: { id: { oneOf: [1, 2] }, note: { any: 'literal' } } }] })).toBeTruthy()
  })

  it('refuses rules that cannot be expressed in a file', () => {
    expect(() => parsePolicyFile({ grounding: 5 })).toThrow(/cannot be set in a policy file/)
    expect(() => parsePolicyFile({ forbid: ['x'], survival: 'x' })).toThrow(/cannot be set in a policy file/)
  })
})

describe('pull-request comment hardening', () => {
  const hostileName = 'x](http://evil.example) <img src=x> @everyone'

  it('keeps names from repository files out of the summary paragraph', () => {
    const r = classifyBehavior([{ calls: [lookup] }], {
      golden: [lookup],
      variants: [{ name: hostileName, calls: [del] }],
      policy: { forbid: ['delete_account'] },
    })
    expect(r.baselineIssues).toHaveLength(1)
    const md = formatBehaviorMarkdown(r)
    const offending = md.split('\n').filter((l) => l.includes('@everyone') && !/^- `[^`]*`$/.test(l))
    expect(offending).toEqual([])
  })

  it('flattens every line terminator, including a lone carriage return', () => {
    const name = 'a\r\r@org/team <img src=x>\u2028# pwned\r\r'
    const r = classifyBehavior([{ calls: [{ name, args: {} }] }, { error: 'boom\r\r# pwned @alice\u2029x' }], { golden: [lookup] })
    const md = formatBehaviorMarkdown(r)
    expect(md).not.toMatch(/[\r\u0085\u2028\u2029]/)
    expect(md.split('\n').filter((l) => /^#+ .*pwned/.test(l))).toEqual([])
  })

  it('bounds error text so one bad response cannot exceed the comment size limit', () => {
    const r = classifyBehavior([{ error: 'x'.repeat(70_000) }], { golden: [lookup] })
    expect(formatBehaviorMarkdown(r).length).toBeLessThan(2_000)
  })
})

describe('recordTrace truncation', () => {
  const fetchLoop = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'lookup_order', arguments: '{}' } }] } }] }), { status: 200 })) as typeof fetch
  const config = { user: 'go', tools: [], apiKey: 'k', httpFetch: fetchLoop }

  it('reports a run that hit maxSteps while still calling tools', async () => {
    let hit: number | undefined
    const trace = await recordTrace({ ...config, maxSteps: 3, onTruncated: (n) => (hit = n) })
    expect(trace.calls).toHaveLength(3)
    expect(hit).toBe(3)
  })

  it('does not report a run that finished', async () => {
    let n = 0
    const finishing = (async () =>
      new Response(JSON.stringify({ choices: [{ message: n++ === 0
        ? { content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'lookup_order', arguments: '{}' } }] }
        : { content: 'done' } }] }), { status: 200 })) as typeof fetch
    let hit = false
    await recordTrace({ ...config, httpFetch: finishing, maxSteps: 3, onTruncated: () => (hit = true) })
    expect(hit).toBe(false)
  })
})

describe('LangGraph adapter: serialized and provider-native messages', () => {
  const call = { name: 'refund_order', args: { orderId: '1' }, id: 'c1', type: 'tool_call' }
  const want = [{ name: 'refund_order', args: { orderId: '1' } }]

  it('reads JSON.stringify output of a LangChain message', () => {
    const serialized = { lc: 1, type: 'constructor', id: ['langchain_core', 'messages', 'AIMessage'], kwargs: { content: '', tool_calls: [call] } }
    expect(traceFromMessages([serialized])).toEqual(want)
    const human = { lc: 1, type: 'constructor', id: ['langchain_core', 'messages', 'HumanMessage'], kwargs: { content: 'hi' } }
    expect(traceFromMessages([human])).toEqual([])
  })

  it('reads toDict() / stored-message output', () => {
    expect(traceFromMessages([{ type: 'ai', data: { content: '', tool_calls: [call] } }])).toEqual(want)
  })

  it('reads calls kept only in additional_kwargs, legacy function_call and Anthropic tool_use blocks', () => {
    const openai = { type: 'ai', content: '', additional_kwargs: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'refund_order', arguments: '{"orderId":"1"}' } }] } }
    const legacy = { type: 'ai', content: '', additional_kwargs: { function_call: { name: 'refund_order', arguments: '{"orderId":"1"}' } } }
    const anthropic = { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'refund_order', input: { orderId: '1' } }] }
    expect(traceFromMessages([openai])).toEqual(want)
    expect(traceFromMessages([legacy])).toEqual(want)
    expect(traceFromMessages([anthropic])).toEqual(want)
  })

  it('does not double-count when tool_calls and a fallback location both hold the call', () => {
    const both = { type: 'ai', content: [{ type: 'tool_use', id: 't1', name: 'refund_order', input: { orderId: '1' } }], tool_calls: [call] }
    expect(traceFromMessages([both])).toEqual(want)
  })

  it('throws on a message whose kind cannot be determined, and skips strings and tuples', () => {
    expect(() => traceFromMessages([{ content: 'mystery', tool_calls: [call] }])).toThrow(/cannot tell what kind of message/)
    expect(traceFromMessages(['hello', ['user', 'hi']])).toEqual([])
  })
})
