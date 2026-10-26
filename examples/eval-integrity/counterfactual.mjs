import { counterfactualReplay, assistantText, assistantWithTools, toolCall } from '../../dist/index.js'

const recording = [{ name: 'read', args: { id: 'x' }, result: { value: 3 } }]
for (const id of ['x', 'different']) {
  let step = 0
  const report = await counterfactualReplay({ prompt: 'Answer briefly.', recording,
    model: { complete: async () => step++ === 0
      ? assistantWithTools([toolCall('read', { id })]) : assistantText('3') } })
  console.log(id, report.status, report.reason)
}
