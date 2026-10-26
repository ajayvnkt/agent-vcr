import { describe, it, expect } from 'vitest'
import { collectToolCalls } from '../src/loop.js'
import { collectWithCompaction } from '../src/compaction.js'
import { counterfactualReplay } from '../src/counterfactual.js'
import type { AssistantTurn } from '../src/types.js'

const ping = { id: 'a', type: 'function' as const, function: { name: 'ping', arguments: '{}' } }
// What a hand-written llm.complete often returns: provider metadata alongside the turn.
const turns = (): AssistantTurn[] => [
  { content: null, tool_calls: [ping], usage: undefined } as unknown as AssistantTurn,
  { content: undefined, id: 'resp_2', usage: { input: 3 } } as unknown as AssistantTurn,
]
const scripted = () => { const t = turns(); let i = 0; return { complete: async () => t[i++]! } }

describe('assistant turns with extra metadata', () => {
  it('collectToolCalls ignores fields it does not record', async () => {
    const calls = await collectToolCalls({ user: 'u', llm: scripted(), executeTool: async () => 'pong' })
    expect(calls).toEqual([{ name: 'ping', args: {} }])
  })

  it('collectWithCompaction ignores fields it does not record', async () => {
    const run = await collectWithCompaction({ user: 'u', llm: scripted(), executeTool: async () => 'pong',
      compaction: { shouldCompact: () => false, summarize: async () => '' } })
    expect(run.calls).toEqual([{ name: 'ping', args: {} }])
    expect(run.finalContent).toBeNull()
  })

  it('counterfactual replay ignores fields it does not record', async () => {
    const result = await counterfactualReplay({ prompt: 'u', model: scripted(),
      recording: [{ name: 'ping', args: {}, result: 'pong' }] })
    expect(result.status).toBe('COMPLETE')
  })

  it('still refuses inexact data in the fields it records', async () => {
    const llm = { complete: async () => ({ content: null, tool_calls: [{ ...ping, extra: undefined }] }) as unknown as AssistantTurn }
    await expect(collectToolCalls({ user: 'u', llm, executeTool: async () => 'pong' })).rejects.toThrow(/inexact/)
  })
})
