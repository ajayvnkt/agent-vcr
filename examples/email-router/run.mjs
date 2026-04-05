/**
 * Example: Email Router Agent
 *
 * An agent that classifies incoming emails and routes them to the right
 * department with the right priority. A prompt change that accidentally
 * routes billing complaints to "general" instead of "billing" would be
 * caught immediately by the trace comparison.
 *
 * Run: npm run example:email-router
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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const goldenPath = join(__dirname, 'traces', 'route-billing.expected.json')

const SYSTEM = `You are an email routing agent.
1. Always classify the email first using classify_email.
2. Then route it to the correct department using route_to_department.
   - Billing complaints → department: "billing", priority: "high"
   - Technical issues  → department: "tech-support", priority: "medium"
   - General enquiries → department: "general", priority: "low"
Never skip the classification step.`

// ── Scripted LLM (no live API call) ──────────────────────────────────────────

const email = {
  subject: 'Invoice #4821 looks wrong',
  body: 'Hi, I was charged twice for my subscription this month.',
}

const llm = new ScriptedLlm([
  // Step 1: classify
  assistantWithTools([
    toolCall('classify_email', { subject: email.subject, body: email.body }, 'c1'),
  ]),
  // Step 2: route based on classification result
  assistantWithTools([
    toolCall(
      'route_to_department',
      { department: 'billing', priority: 'high', ticketId: 'generated' },
      'c2',
    ),
  ]),
  assistantText('Email routed to billing with high priority.'),
])

// ── Stub tool backend ─────────────────────────────────────────────────────────

async function executeTool(name, args) {
  if (name === 'classify_email') {
    return { category: 'billing', confidence: 0.97, sentiment: 'negative' }
  }
  if (name === 'route_to_department') {
    return { ticketId: args.ticketId, queued: true, estimatedResponseHours: 4 }
  }
  throw new Error(`Unknown tool: ${name}`)
}

// ── Run + compare ─────────────────────────────────────────────────────────────

const recorded = await collectToolCalls({
  system: SYSTEM,
  user: `Route this email — Subject: "${email.subject}" | Body: "${email.body}"`,
  llm,
  executeTool,
})

const expected = await loadTraceFile(goldenPath)
const result = compareTraces(expected.calls, recorded)

if (!result.ok) {
  console.error('TRACE MISMATCH:', result.reason)
  if (result.expected) console.error('  expected:', result.expected)
  if (result.actual) console.error('  actual:  ', result.actual)
  process.exit(1)
}

console.error(`OK: email-router — ${recorded.length} tool calls matched golden trace`)
console.error(`    ${recorded.map((c) => c.name).join(' → ')}`)
