import { describe, it, expect } from 'vitest'
import { collectToolCalls, assistantText, assistantWithTools, toolCall } from '../src/loop.js'
import { ScriptedLlm } from '../src/scripted-llm.js'
import { compareTraces } from '../src/diff.js'

describe('collectToolCalls + ScriptedLlm', () => {
  it('records a two-tool refund flow matching golden', async () => {
    const llm = new ScriptedLlm([
      assistantWithTools([toolCall('lookup_order', { orderId: '123' }, 'id1')]),
      assistantWithTools([toolCall('refund_order', { orderId: '123', amount: 10 }, 'id2')]),
      assistantText('Done.'),
    ])

    const tools = {
      lookup_order: async () => ({ ok: true }),
      refund_order: async () => ({ refunded: true }),
    }

    const recorded = await collectToolCalls({
      system: 'You are a test agent.',
      user: 'Refund order 123',
      llm,
      async executeTool(name, args) {
        const fn = tools[name as keyof typeof tools]
        if (!fn) throw new Error(`unknown tool ${name}`)
        return fn(args as never)
      },
    })

    const golden = {
      version: 1 as const,
      scenario: 'refund',
      calls: [
        { name: 'lookup_order', args: { orderId: '123' } },
        { name: 'refund_order', args: { orderId: '123', amount: 10 } },
      ],
    }

    expect(compareTraces(golden.calls, recorded)).toEqual({ ok: true })
    expect(llm.remaining()).toBe(0)
  })

  it('throws when scripted turns run out mid-flight', async () => {
    const llm = new ScriptedLlm([assistantWithTools([toolCall('a', {}, 'id1')])])

    await expect(
      collectToolCalls({
        user: 'x',
        llm,
        maxSteps: 4,
        async executeTool() {
          return 'ok'
        },
      }),
    ).rejects.toThrow(/no more scripted turns/)
  })

  it('throws when maxSteps stops after tool without final assistant', async () => {
    const llm = new ScriptedLlm([
      assistantWithTools([toolCall('only', {}, 'id1')]),
      assistantWithTools([toolCall('only', {}, 'id2')]),
    ])

    await expect(
      collectToolCalls({
        user: 'x',
        llm,
        maxSteps: 1,
        async executeTool() {
          return 'ok'
        },
      }),
    ).rejects.toThrow(/maxSteps/)
  })
})
