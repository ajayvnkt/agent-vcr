import { describe, expect, it } from 'vitest'
import { counterfactualReplay } from '../src/counterfactual.js'
import { assistantText, assistantWithTools, toolCall } from '../src/loop.js'

const recording = [
  { name: 'read', args: { id: 'x', flags: [1, 2] }, result: { value: 7 } },
  { name: 'write', args: { id: 'x', value: 7 }, result: 'stored' },
]

describe('counterfactual replay never fabricates tool returns', () => {
  it('delivers recorded results under a changed prompt and consumes the exact sequence', async () => {
    let step = 0
    const result = await counterfactualReplay({ prompt: 'Use fewer words.', recording,
      model: { complete: async messages => {
        expect(messages[0]!.content).toBe('Use fewer words.')
        if (step++ === 0) return assistantWithTools([toolCall('read', { flags: [1, 2], id: 'x' }, 'a')])
        if (step === 2) {
          expect(messages.at(-1)!.content).toBe('{"value":7}')
          return assistantWithTools([toolCall('write', { id: 'x', value: 7 }, 'b')])
        }
        expect(messages.at(-1)!.content).toBe('stored')
        return assistantText('done')
      } } })
    expect(result.status).toBe('COMPLETE')
    expect(result.consumed).toBe(2)
  })

  it.each([
    toolCall('unknown', { id: 'x' }),
    toolCall('read', { id: 'y', flags: [1, 2] }),
    toolCall('read', { id: 'x', flags: [2, 1] }),
    toolCall('read', { id: 'x', flags: [1, 2], extra: true }),
    toolCall('write', { id: 'x', value: 7 }),
  ])('aborts at the first name, argument, order or shape mismatch', async request => {
    let calls = 0
    const result = await counterfactualReplay({ prompt: 'changed', recording, model: {
      complete: async () => { calls++; return assistantWithTools([request]) },
    } })
    expect(result.status).toBe('INCONCLUSIVE')
    expect(result.consumed).toBe(0)
    expect(calls).toBe(1)
    expect(result.messages.some(m => m.role === 'tool')).toBe(false)
  })

  it('does not release even a matching prefix of a divergent batch', async () => {
    const result = await counterfactualReplay({ prompt: 'changed', recording, model: {
      complete: async () => assistantWithTools([toolCall('read', recording[0]!.args, 'a'),
        toolCall('write', { id: 'other' }, 'b')]),
    } })
    expect(result.status).toBe('INCONCLUSIVE')
    expect(result.consumed).toBe(0)
    expect(result.divergence?.atCall).toBe(1)
  })

  it('rejects early termination, excess calls, missing returns, malformed arguments and callback errors', async () => {
    const early = await counterfactualReplay({ prompt: 'changed', recording,
      model: { complete: async () => assistantText('done') } })
    expect(early.status).toBe('INCONCLUSIVE')
    const excess = await counterfactualReplay({ prompt: 'changed', recording: [],
      model: { complete: async () => assistantWithTools([toolCall('read', {})]) } })
    expect(excess.status).toBe('INCONCLUSIVE')
    const missing = await counterfactualReplay({ prompt: 'changed',
      recording: [{ name: 'read', args: {} }] as never,
      model: { complete: async () => { throw new Error('must not run') } } })
    expect(missing.modelCalls).toBe(0)
    const malformed = toolCall('read', {})
    malformed.function.arguments = '['
    expect((await counterfactualReplay({ prompt: 'changed', recording,
      model: { complete: async () => assistantWithTools([malformed]) } })).status).toBe('INCONCLUSIVE')
    expect((await counterfactualReplay({ prompt: 'changed', recording,
      model: { complete: async () => { throw new Error('offline model error') } } })).status).toBe('INCONCLUSIVE')
  })

  it('does not share mutable history or caller recording with the model', async () => {
    let step = 0
    const result = await counterfactualReplay({ prompt: 'original', recording: [recording[0]!],
      model: { complete: async messages => {
        messages[0]!.content = 'mutated'
        return step++ === 0 ? assistantWithTools([toolCall('read', recording[0]!.args)]) : assistantText('done')
      } } })
    expect(result.messages[0]!.content).toBe('original')
    expect(result.status).toBe('COMPLETE')
  })
})
