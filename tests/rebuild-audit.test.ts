import { expect, it } from 'vitest'
import { replayPlannerRouting } from '../src/planner.js'

it('stops at the first divergent plan without routing later plans', () => {
  const routed: string[] = []
  const result = replayPlannerRouting({
    routerId: 'audit-router',
    trace: { version: 1, calls: [{ name: 'read', args: { id: 'a' } }, { name: 'read', args: { id: 'b' } }],
      plannerOutputs: [{ atStep: 1, atCall: 0, callCount: 1, text: 'first' },
        { atStep: 2, atCall: 1, callCount: 1, text: 'later' }] },
    route: text => { routed.push(text); return [{ name: 'read', args: { id: 'different' } }] },
  })
  expect(result.status).toBe('UNKNOWN')
  expect(result.disposition).toBe('INCONCLUSIVE')
  expect(routed).not.toContain('later')
  expect(result.plans).toHaveLength(1)
  expect(result.modelCalls).toBe(0)
  expect(result.toolCalls).toBe(0)
})
