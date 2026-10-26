import { expect, it } from 'vitest'
import { counterfactualReplay } from '../src/counterfactual.js'
import { assistantText, assistantWithTools, toolCall } from '../src/loop.js'
import { replayPlannerRouting } from '../src/planner.js'

it.each([
  ['different number', { id: 1, flags: [] }, '{"id":2,"flags":[]}'],
  ['rounded integer', { id: 9007199254740992 }, '{"id":9007199254740993}'],
  ['rounded fraction', { id: 0.1 }, '{"id":0.10000000000000001}'],
  ['reordered keys', { id: 1, flags: [] }, '{"flags":[],"id":1}'],
  ['extra key', { id: 1 }, '{"id":1,"extra":null}'],
  ['missing key', { id: 1, flags: [] }, '{"id":1}'],
  ['duplicate key', { id: 1 }, '{"id":2,"id":1}'],
] as const)('refuses %s before releasing any return', async (_name, args, raw) => {
  let step = 0
  const request = toolCall('read', {}, 'a')
  request.function.arguments = raw
  const result = await counterfactualReplay({ prompt: 'task', recording: [{ name: 'read', args, result: 'secret' }],
    model: { complete: async () => step++ === 0 ? assistantWithTools([request]) : assistantText('done') } })
  expect(result.status).toBe('INCONCLUSIVE')
  expect(result.consumed).toBe(0)
  expect(result.messages.filter(m => m.role === 'tool')).toEqual([])
})

it('refuses the same tool from a different sequence position', async () => {
  const result = await counterfactualReplay({ prompt: 'task', recording: [
    { name: 'read', args: { id: 1 }, result: 'first' }, { name: 'read', args: { id: 2 }, result: 'second' },
  ], model: { complete: async () => assistantWithTools([toolCall('read', { id: 2 })]) } })
  expect(result.status).toBe('INCONCLUSIVE')
  expect(result.consumed).toBe(0)
  expect(result.messages.filter(m => m.role === 'tool')).toEqual([])
})

it.each(['sparse', 'getter', 'uncloneable'] as const)('refuses %s values without throwing or releasing returns', async kind => {
  const args = kind === 'sparse' ? { items: new Array(1) } : { id: 1 }
  const request = toolCall('read', kind === 'sparse' ? { items: [] } : { id: 1 })
  if (kind === 'getter') Object.defineProperty(request.function, 'arguments', { enumerable: true, get: () => '{"id":1}' })
  if (kind === 'uncloneable') Object.assign(request, { callback: () => null })
  let step = 0
  const result = await counterfactualReplay({ prompt: 'task', recording: [{ name: 'read', args, result: 7 }],
    model: { complete: async () => step++ === 0 ? assistantWithTools([request]) : assistantText('done') } })
  expect(result.status).toBe('INCONCLUSIVE')
  expect(result.consumed).toBe(0)
  expect(result.messages.filter(m => m.role === 'tool')).toEqual([])
})

it.each([
  [{ id: 1, flags: [] }, { flags: [], id: 1 }],
  [{ id: 9007199254740992 }, { id: 9007199254740993 }],
] as const)('planner routing cannot certify ambiguous identity', (expected, actual) => {
  const result = replayPlannerRouting({ routerId: 'test',
    trace: { version: 1, calls: [{ name: 'read', args: expected }],
      plannerOutputs: [{ atStep: 1, atCall: 0, callCount: 1, text: 'read' }] },
    route: () => [{ name: 'read', args: actual }] })
  expect(result.status).toBe('UNKNOWN')
  expect(result.modelCalls).toBe(0)
  expect(result.toolCalls).toBe(0)
})
