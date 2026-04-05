/**
 * Minimal example: scripted LLM + stub tools → trace → compare to golden JSON.
 * Run from repo root: npm run example:minimal
 */

import {
  ScriptedLlm,
  assistantText,
  assistantWithTools,
  collectToolCalls,
  compareTraces,
  loadTraceFile,
  toolCall,
} from '../../dist/index.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const goldenPath = join(__dirname, 'traces', 'refund.expected.json')

const llm = new ScriptedLlm([
  assistantWithTools([toolCall('lookup_order', { orderId: '123' }, 'id1')]),
  assistantWithTools([toolCall('refund_order', { orderId: '123', amount: 10 }, 'id2')]),
  assistantText('Refund complete.'),
])

const recorded = await collectToolCalls({
  system: 'Test agent.',
  user: 'Please refund order 123 for $10',
  llm,
  async executeTool(name) {
    if (name === 'lookup_order') return { found: true }
    if (name === 'refund_order') return { ok: true }
    throw new Error(`unknown tool ${name}`)
  },
})

const expected = await loadTraceFile(goldenPath)
const result = compareTraces(expected.calls, recorded)

if (!result.ok) {
  console.error('TRACE MISMATCH', result)
  process.exit(1)
}

console.error('OK: minimal example matches', goldenPath)
