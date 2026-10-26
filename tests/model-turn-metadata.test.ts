import { describe, it, expect } from 'vitest'
import { collectToolCalls } from '../src/loop.js'
import { collectWithCompaction } from '../src/compaction.js'
import { counterfactualReplay } from '../src/counterfactual.js'
import type { AssistantTurn } from '../src/types.js'

const ping = { id: 'a', type: 'function' as const, function: { name: 'ping', arguments: '{}' } }
// What a hand-written llm.complete often returns: provider metadata alongside the turn.
const turns = (): AssistantTurn[] => [
  { content: null, tool_calls: [ping], usage: undefined } as unknown as AssistantTurn,
  { content: 'done', id: 'resp_2', usage: { input: 3 }, extra: undefined } as unknown as AssistantTurn,
]
const scripted = (t: AssistantTurn[] = turns()) => { let i = 0; return { complete: async () => t[i++]! } }
const once = (turn: unknown) => ({ complete: async () => turn as AssistantTurn })

describe('assistant turns with extra metadata', () => {
  it('collectToolCalls ignores fields it does not record', async () => {
    const calls = await collectToolCalls({ user: 'u', llm: scripted(), executeTool: async () => 'pong' })
    expect(calls).toEqual([{ name: 'ping', args: {} }])
  })

  it('collectWithCompaction ignores fields it does not record', async () => {
    const run = await collectWithCompaction({ user: 'u', llm: scripted(), executeTool: async () => 'pong',
      compaction: { shouldCompact: () => false, summarize: async () => '' } })
    expect(run.calls).toEqual([{ name: 'ping', args: {} }])
    expect(run.finalContent).toBe('done')
  })

  it('counterfactual replay ignores fields it does not record', async () => {
    const result = await counterfactualReplay({ prompt: 'u', model: scripted(),
      recording: [{ name: 'ping', args: {}, result: 'pong' }] })
    expect(result.status).toBe('COMPLETE')
  })

  it('counterfactual replay still reports responses without content as malformed', async () => {
    for (const response of [{}, { text: 'hi' }, { choices: [] }, { content: undefined, usage: {} }]) {
      const result = await counterfactualReplay({ prompt: 'u', model: once(response), recording: [] })
      expect(result).toMatchObject({ status: 'INCONCLUSIVE', reason: 'malformed model response' })
    }
  })

  it('still refuses inexact data in the fields it records', async () => {
    const nested = once({ content: null, tool_calls: [{ ...ping, extra: undefined }] })
    await expect(collectToolCalls({ user: 'u', llm: nested, executeTool: async () => 'pong' })).rejects.toThrow(/inexact/)
  })

  it('still refuses getters, hidden fields, inherited fields and non-plain turns', async () => {
    const getter = { content: null, get tool_calls() { return [ping] } }
    const hidden = Object.defineProperty({ content: null }, 'tool_calls', { value: [ping], enumerable: false })
    const inherited = Object.assign(Object.create({ tool_calls: [ping] }), { content: null })
    class Turn { content = null; tool_calls = [ping] }
    for (const turn of [getter, hidden, inherited, new Turn()]) {
      await expect(collectToolCalls({ user: 'u', llm: once(turn), executeTool: async () => 'pong' })).rejects.toThrow()
    }
  })
})
