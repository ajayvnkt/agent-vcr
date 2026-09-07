/**
 * The full reliability suite, no live model and no API key.
 *
 * Four scenarios, each showing one thing a plain golden trace cannot express:
 *
 *   1. policy        — verification must precede the payout, whatever else happens
 *   2. multi-turn    — the agent must clarify before acting, then act
 *   3. paths         — a cache hit and a cache miss are both correct
 *   4. reliability   — passes every run, but not the same way twice
 *
 * The fourth is the one worth watching. It passes 6/6 and the gate still fails
 * it, which is the whole argument: a pass rate cannot see behavioural variance,
 * and behavioural variance is what breaks long-running agents in production.
 *
 * Run from repo root: npm run example:reliability-suite
 */

import { formatConsole, formatMarkdown, keywordJudge, runSuite } from '../../dist/index.js'

const call = (name, args = {}) => ({ name, args })

/** Deterministic PRNG so the demo reproduces exactly. */
function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(11)

// ── The agents under test ─────────────────────────────────────────────────────

/** Refunds without verifying first — the bug from the original Agent VCR article. */
const unsafeRefundAgent = () => ({
  send: async () => ({
    calls: [call('lookup_order', { orderId: '123' }), call('refund_order', { orderId: '123', amount: 40 })],
    finalContent: 'Refunded $40 on order 123.',
  }),
})

/** Clarifies on turn one, acts on turn two. */
const clarifyingAgent = () => {
  let turn = 0
  return {
    send: async () => {
      turn++
      if (turn === 1) {
        return { calls: [call('list_orders', { user: 'u-22' })], finalContent: 'Which order — 123 or 456?' }
      }
      return {
        calls: [call('verify_order', { orderId: '123' }), call('refund_order', { orderId: '123', amount: 40 })],
        finalContent: 'Refunded $40 on order 123.',
      }
    },
  }
}

/** Sometimes hits a cache, sometimes fetches. Both are legitimate. */
const cachingAgent = () => ({
  send: async () => {
    const hit = rand() < 0.5
    return {
      calls: hit
        ? [call('lookup_order', { orderId: '123' }), call('reply', {})]
        : [call('lookup_order', { orderId: '123' }), call('fetch_order', { orderId: '123' }), call('reply', {})],
      finalContent: 'Order 123 shipped on Tuesday.',
    }
  },
})

/** Reaches the right answer by a different route each time. Passes every run. */
const wanderingAgent = () => ({
  send: async () => {
    const route = Math.floor(rand() * 3)
    const middle =
      route === 0
        ? [call('search_docs', { q: 'policy' })]
        : route === 1
          ? [call('search_docs', { q: 'refund policy' }), call('read_doc', { id: 'p-1' })]
          : [call('read_doc', { id: 'p-1' })]
    return {
      calls: [call('open_ticket', { id: 'T-9' }), ...middle, call('answer', {})],
      finalContent: 'Refunds are allowed within 30 days.',
    }
  },
})

// ── The suite ─────────────────────────────────────────────────────────────────

const scenarios = [
  {
    name: 'refund/policy',
    turns: [
      {
        user: 'Refund $40 on order 123',
        // Not a fixed sequence — a rule. Any trace is fine as long as it holds.
        expect: {
          // A safety rule, not an ordering rule: never refund without verifying.
          // `ordering` would pass this agent, because it never verifies at all.
          requires: [['refund_order', 'verify_order']],
          forbid: ['delete_account', 'close_ticket'],
          maxCallsPerTool: 2,
        },
        output: { contains: ['refunded'], notContains: ['as an ai'] },
        rubric: 'expect: refunded; expect: order 123',
      },
    ],
  },
  {
    name: 'refund/clarify-first',
    turns: [
      { user: 'I want a refund', expect: { forbid: ['refund_order'] } },
      { user: 'Order 123 please', expect: { includes: ['refund_order'] } },
    ],
    expectOverall: { ordering: [['verify_order', 'refund_order']] },
  },
  {
    name: 'lookup/either-path',
    runs: 6,
    turns: [{ user: 'When did order 123 ship?', expect: { includes: ['reply'] } }],
    variants: [
      { name: 'cache-hit', calls: [call('lookup_order', { orderId: '123' }), call('reply', {})], note: 'order already cached' },
      {
        name: 'cache-miss',
        calls: [call('lookup_order', { orderId: '123' }), call('fetch_order', { orderId: '123' }), call('reply', {})],
        note: 'cold cache, one extra fetch',
      },
    ],
  },
  {
    name: 'policy-qa/reliability',
    runs: 6,
    turns: [{ user: 'What is the refund policy?', expect: { includes: ['answer'] } }],
  },
]

// Each scenario brings its own agent.
scenarios[0].agent = unsafeRefundAgent
scenarios[1].agent = clarifyingAgent
scenarios[2].agent = cachingAgent
scenarios[3].agent = wanderingAgent

// One suite run, gated on both correctness and consistency.
const result = await runSuite(scenarios, {
  runs: 1,
  judge: keywordJudge(),
  gate: { minPassRate: 1, requireStable: true },
})

console.log(formatConsole(result))
console.log('\n── What CI would post on the PR ──────────────────────────\n')
console.log(formatMarkdown(result, { title: 'Agent reliability', commit: 'a1b2c3d4e5f6' }))
console.log(
  `\nJudge calls: ${result.totals.judgeCalls} — the judge is only paid for runs that already passed everything free.\n`,
)
