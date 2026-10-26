import { describe, it, expect, vi } from 'vitest'
import { collectToolCalls, assistantText, assistantWithTools } from '../src/loop.js'
import { ScriptedLlm } from '../src/scripted-llm.js'
import { counterfactualReplay } from '../src/counterfactual.js'
import { recordTrace } from '../src/record.js'
import { parseToolArguments, parseExactArguments } from '../src/replay-identity.js'
import type { ToolCallSpec } from '../src/types.js'

const zeroArg = (id: string, args: string): ToolCallSpec =>
  ({ id, type: 'function', function: { name: 'ping', arguments: args } })

describe('zero-argument tool calls', () => {
  it('treats empty or whitespace argument text as {}', () => {
    expect(parseToolArguments('')).toEqual({})
    expect(parseToolArguments('  \n')).toEqual({})
    expect(() => parseToolArguments('not-json{')).toThrow()
    // Whole-file parsing stays strict: an empty trace file is still an error.
    expect(() => parseExactArguments('')).toThrow()
  })

  it('collectToolCalls records "" arguments as {}', async () => {
    const llm = new ScriptedLlm([
      assistantWithTools([zeroArg('a', ''), zeroArg('b', '{}')]),
      assistantText('Done.'),
    ])
    const executeTool = vi.fn(async () => 'pong')
    const calls = await collectToolCalls({ user: 'ping twice', llm, executeTool })
    expect(calls).toEqual([{ name: 'ping', args: {} }, { name: 'ping', args: {} }])
    expect(executeTool).toHaveBeenCalledWith('ping', {})
  })

  it('counterfactual replay matches "" arguments against a recorded {}', async () => {
    let turn = 0
    const result = await counterfactualReplay({
      prompt: 'ping',
      recording: [{ name: 'ping', args: {}, result: 'pong' }],
      model: { complete: async () => (turn++ === 0
        ? { content: null, tool_calls: [zeroArg('a', '')] }
        : { content: 'done' }) },
    })
    expect(result.status).toBe('COMPLETE')
  })

  it('recordTrace records "" arguments as {}', async () => {
    let call = 0
    const httpFetch = vi.fn(async () => new Response(JSON.stringify(call++ === 0
      ? { choices: [{ message: { content: null, tool_calls: [zeroArg('c1', '')] } }] }
      : { choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const trace = await recordTrace({ apiKey: 'sk-x', user: 'u', maxSteps: 4, httpFetch,
      tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object', properties: {} } } }] })
    expect(trace.calls).toEqual([{ name: 'ping', args: {} }])
  })
})
