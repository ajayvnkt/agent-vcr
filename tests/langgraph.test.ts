import { describe, it, expect } from 'vitest'
import { collectFromLangGraph, traceFromMessages, traceFromState } from '../src/adapters/langgraph.js'
import { assertTrace } from '../src/assert.js'
import { classifyRun } from '../src/behavior.js'

/** Stand-ins shaped like the LangChain message classes, without importing them. */
class FakeAIMessage {
  type = 'ai'
  constructor(
    public content: string,
    public tool_calls: unknown[] = [],
    public invalid_tool_calls: unknown[] = [],
  ) {}
}
class FakeToolMessage {
  type = 'tool'
  constructor(public content: string, public tool_call_id: string) {}
}
class LegacyAIMessage {
  constructor(public content: string, public tool_calls: unknown[]) {}
  _getType(): string {
    return 'ai'
  }
}

const state = {
  messages: [
    { role: 'user', content: 'Refund order 4471' },
    new FakeAIMessage('', [{ name: 'lookup_order', args: { orderId: '4471' }, id: 'c1', type: 'tool_call' }]),
    new FakeToolMessage('found', 'c1'),
    new FakeAIMessage('', [
      { name: 'verify_order', args: { orderId: '4471' }, id: 'c2' },
      { name: 'refund_order', args: { orderId: '4471', amount: 40 }, id: 'c3' },
    ]),
    new FakeToolMessage('ok', 'c2'),
    new FakeToolMessage('ok', 'c3'),
    new FakeAIMessage('Refunded.'),
  ],
}

describe('LangGraph adapter', () => {
  it('extracts requested tool calls in message order, including parallel calls', () => {
    expect(traceFromState(state)).toEqual([
      { name: 'lookup_order', args: { orderId: '4471' } },
      { name: 'verify_order', args: { orderId: '4471' } },
      { name: 'refund_order', args: { orderId: '4471', amount: 40 } },
    ])
  })

  it('reads legacy _getType(), getType() and OpenAI-shaped dict messages', () => {
    const calls = traceFromMessages([
      new LegacyAIMessage('', [{ name: 'a', args: {} }]),
      { getType: () => 'ai', tool_calls: [{ name: 'b', args: { x: 1 } }] },
      { role: 'assistant', tool_calls: [{ id: 'x', type: 'function', function: { name: 'c', arguments: '{"y":2}' } }] },
      { role: 'assistant', tool_calls: [{ function: { name: 'd', arguments: '' } }] },
      { type: 'human', content: 'hi', tool_calls: [{ name: 'ignored', args: {} }] },
    ])
    expect(calls).toEqual([
      { name: 'a', args: {} },
      { name: 'b', args: { x: 1 } },
      { name: 'c', args: { y: 2 } },
      { name: 'd', args: {} },
    ])
  })

  it('skips leading history when asked', () => {
    expect(traceFromState(state, { skipMessages: 3 }).map((c) => c.name)).toEqual(['verify_order', 'refund_order'])
    expect(() => traceFromState(state, { skipMessages: -1 })).toThrow(/non-negative/)
  })

  it('supports a custom messages key and fails clearly without one', () => {
    expect(traceFromState({ chat: state.messages }, { messagesKey: 'chat' })).toHaveLength(3)
    expect(() => traceFromState({ chat: state.messages })).toThrow(/no "messages" array/)
    expect(() => traceFromState(null)).toThrow(/not an object/)
  })

  it('throws on malformed tool calls instead of dropping them', () => {
    expect(() => traceFromMessages([{ type: 'ai', tool_calls: [{ args: {} }] }])).toThrow(/no name/)
    expect(() => traceFromMessages([{ type: 'ai', tool_calls: [{ name: 'a', args: 'x' }] }])).toThrow(/non-object args/)
    expect(() => traceFromMessages([{ type: 'ai', tool_calls: [{ function: { name: 'a', arguments: '{bad' } }] }])).toThrow(/not valid JSON/)
    expect(() => traceFromMessages([{ type: 'ai', tool_calls: 'nope' }])).toThrow(/not an array/)
  })

  it('throws when the model emitted tool calls the framework could not parse', () => {
    const bad = new FakeAIMessage('', [], [{ name: 'refund_order', args: '{"orderId":', error: 'parse' }])
    expect(() => traceFromMessages([bad])).toThrow(/could not be parsed/)
  })

  it('invokes a graph, forwards config, and feeds assertions and behaviour checks', async () => {
    const seen: unknown[] = []
    const graph = {
      invoke: async (input: unknown, config?: Record<string, unknown>) => {
        seen.push(input, config)
        return state
      },
    }
    const input = { messages: [{ role: 'user', content: 'Refund order 4471' }] }
    const { calls, state: out } = await collectFromLangGraph(graph, input, { config: { recursionLimit: 10 } })
    expect(seen).toEqual([input, { recursionLimit: 10 }])
    expect(out).toBe(state)
    expect(assertTrace(calls, { requires: [['refund_order', 'verify_order']] })).toEqual([])
    expect(classifyRun(calls, { golden: calls }).class).toBe('golden')
  })

  it('does not pass a config argument when none is given', async () => {
    let argCount = -1
    const graph = {
      invoke: async (...args: unknown[]) => {
        argCount = args.length
        return state
      },
    }
    await collectFromLangGraph(graph, {})
    expect(argCount).toBe(1)
  })
})
