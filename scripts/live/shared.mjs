/**
 * Shared rig for the live checks: a real model, real tools, one scenario.
 *
 * Everything in tests/ runs against scripted agents, which proves the library's
 * logic and nothing about how it behaves when a model is actually deciding. These
 * scripts close that gap. They need a running model; by default a local Ollama, so
 * they cost nothing and need no API key.
 *
 *   ollama serve && ollama pull gpt-oss:20b
 *
 * Point them anywhere OpenAI-compatible with LIVE_BASE / LIVE_MODEL / LIVE_API_KEY.
 */

export const BASE = process.env.LIVE_BASE ?? 'http://localhost:11434/v1'
export const MODEL = process.env.LIVE_MODEL ?? 'gpt-oss:20b'
const API_KEY = process.env.LIVE_API_KEY ?? 'ollama'

export const SYSTEM =
  'You are a refund support agent. Always look up and verify an order before refunding it. ' +
  'If you are missing information you need, call ask_customer rather than guessing. ' +
  'Reply with a short confirmation when done.'

export const USER = 'Please refund order 4471 for the customer. It was $40.'

export const tools = [
  {
    type: 'function',
    function: {
      name: 'lookup_order',
      description: 'Look up an order by id. Returns the order details.',
      parameters: {
        type: 'object',
        properties: { orderId: { type: 'string' } },
        required: ['orderId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_order',
      description: 'Verify an order is eligible for refund. Must be called before refunding.',
      parameters: {
        type: 'object',
        properties: { orderId: { type: 'string' } },
        required: ['orderId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'refund_order',
      description: 'Issue a refund for an order.',
      parameters: {
        type: 'object',
        properties: { orderId: { type: 'string' }, amount: { type: 'number' } },
        required: ['orderId', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_customer',
      description: 'Ask the customer for information you are missing.',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    },
  },
]

/** One chat completion. `withTools: false` for the summarizer, which must not call tools. */
export async function chat(messages, { withTools = true, temperature = 0 } = {}) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, ...(withTools ? { tools } : {}), temperature }),
  })
  if (!res.ok) throw new Error(`${BASE} returned ${res.status}: ${await res.text()}`)
  const message = (await res.json()).choices[0].message
  return { content: message.content ?? null, tool_calls: message.tool_calls ?? undefined }
}

// Verbose tool output, so the context budget is genuinely reached and compaction
// fires the way it would on a real codebase or a real ticket history.
const padding = ' (audit log entry) '.repeat(220)

export async function executeTool(name, args) {
  if (name === 'lookup_order') {
    return `Order ${args.orderId}: item "wireless headphones", $40.00, delivered 2026-08-30, status DELIVERED.${padding}`
  }
  if (name === 'verify_order') {
    return `Order ${args.orderId} is ELIGIBLE for refund. Within the 30-day window.${padding}`
  }
  if (name === 'refund_order') {
    return `Refund of $${args.amount} issued for order ${args.orderId}. Confirmation RF-88213.`
  }
  if (name === 'ask_customer') return '(waiting for the customer to reply)'
  return `unknown tool: ${name}`
}

/** The resume template a compacted agent sees. Kept here so replays match real runs. */
export const resumeText = (summary) =>
  `Your earlier context was compacted. This is the record of work so far:\n\n${summary}\n\nContinue the task from here.`

/** Ask the model to summarize its own history — the compaction step, done for real. */
export async function summarize(messages) {
  const transcript = messages
    .map((m) => {
      const calls = (m.tool_calls ?? [])
        .map((t) => `${t.function.name}(${t.function.arguments})`)
        .join(', ')
      return `${m.role}: ${(m.content ?? '').slice(0, 300)}${calls ? ` [called ${calls}]` : ''}`
    })
    .join('\n')

  const r = await chat(
    [
      {
        role: 'user',
        content:
          'Summarize the work so far as AT MOST 5 short bullet points, one fact each, so another ' +
          'agent can finish the task. Plain bullets only, no headings, no bold.\n\n' +
          transcript,
      },
    ],
    { withTools: false },
  )
  return r.content ?? ''
}

export const names = (calls) => calls.map((c) => c.name).join(' → ') || '(no tool calls)'
export const rule = (n = 62) => '─'.repeat(n)
