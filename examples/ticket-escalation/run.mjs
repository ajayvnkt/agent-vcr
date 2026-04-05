/**
 * Example: VIP Ticket Escalation Agent
 *
 * Tests a multi-step customer support escalation flow.
 * Ensures the agent always checks customer tier, reviews history,
 * escalates correctly, and sends confirmation — never skipping steps
 * that would leave a VIP customer without acknowledgment.
 *
 * Run: npm run example:ticket-escalation
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
const goldenPath = join(__dirname, 'traces', 'escalate-vip.expected.json')

const SYSTEM = `You are a support ticket escalation agent.
Always follow this sequence:
1. lookup_customer — get customer tier and ID
2. get_ticket_history — check unresolved issues count
3. escalate_ticket — if customer is VIP OR has 3+ unresolved tickets
4. send_notification — always notify the customer after escalation

For VIP customers: tier = "priority", assignTo = "senior-support".`

const ticketRequest = {
  ticketId: 'tkt_999',
  customerEmail: 'vip@acme.com',
  issue: 'Payment not processing for the third time this week',
}

// ── Scripted LLM ──────────────────────────────────────────────────────────────

const llm = new ScriptedLlm([
  assistantWithTools([
    toolCall('lookup_customer', { email: ticketRequest.customerEmail }, 'c1'),
  ]),
  assistantWithTools([
    toolCall('get_ticket_history', { customerId: 'cust_vip_001', limit: 5 }, 'c2'),
  ]),
  assistantWithTools([
    toolCall('escalate_ticket', {
      ticketId: ticketRequest.ticketId,
      tier: 'priority',
      assignTo: 'senior-support',
      reason: 'VIP customer with 3+ unresolved issues',
    }, 'c3'),
  ]),
  assistantWithTools([
    toolCall('send_notification', {
      customerId: 'cust_vip_001',
      channel: 'email',
      templateId: 'escalation-confirmed',
    }, 'c4'),
  ]),
  assistantText('Ticket escalated to senior support. Customer notified via email.'),
])

// ── Stub tool backend ─────────────────────────────────────────────────────────

async function executeTool(name, args) {
  if (name === 'lookup_customer') {
    return { customerId: 'cust_vip_001', tier: 'vip', name: 'Acme Corp', email: args.email }
  }
  if (name === 'get_ticket_history') {
    return {
      customerId: args.customerId,
      tickets: [
        { id: 'tkt_990', status: 'open', age: '2d' },
        { id: 'tkt_985', status: 'open', age: '5d' },
        { id: 'tkt_978', status: 'open', age: '8d' },
      ],
      unresolvedCount: 3,
    }
  }
  if (name === 'escalate_ticket') {
    return { escalated: true, assignedTo: args.assignTo, escalationId: 'esc_001' }
  }
  if (name === 'send_notification') {
    return { sent: true, channel: args.channel, messageId: 'msg_' + Date.now() }
  }
  throw new Error(`Unknown tool: ${name}`)
}

// ── Run + compare ─────────────────────────────────────────────────────────────

const recorded = await collectToolCalls({
  system: SYSTEM,
  user: `Escalate ticket ${ticketRequest.ticketId} for ${ticketRequest.customerEmail}: "${ticketRequest.issue}"`,
  llm,
  executeTool,
})

const expected = await loadTraceFile(goldenPath)
const result = compareTraces(expected.calls, recorded)

if (!result.ok) {
  console.error('TRACE MISMATCH:', result.reason)
  if (result.expected) console.error('  expected:', result.expected)
  if (result.actual)   console.error('  actual:  ', result.actual)
  process.exit(1)
}

console.error(`OK: ticket-escalation — ${recorded.length} tool calls matched golden trace`)
console.error(`    ${recorded.map((c) => c.name).join(' → ')}`)
