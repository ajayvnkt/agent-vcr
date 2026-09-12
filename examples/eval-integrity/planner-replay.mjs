import { replayPlannerRouting } from '../../dist/index.js'

const trace = { version: 1, calls: [{ name: 'read', args: { id: 'x' } }],
  plannerOutputs: [{ atStep: 1, atCall: 0, callCount: 1, text: 'x' }] }
for (const name of ['read', 'write']) {
  const report = replayPlannerRouting({ trace, routerId: `router-${name}`,
    route: text => [{ name, args: { id: text } }] })
  console.log(JSON.stringify(report, null, 2))
}
