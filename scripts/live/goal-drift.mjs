/**
 * Live check 3 — a reproduction of a real compaction failure.
 *
 * Running `ablation.mjs` against gpt-oss:20b produced this summary at the cut,
 * after the agent had looked up and verified order 4471 — and had NOT refunded it:
 *
 *   - Order 4471 is for wireless headphones
 *   - Price is $40.00
 *   - Delivered on 2026-08-30
 *   - Current status: DELIVERED
 *   - Eligible for refund
 *   - Refund processed.            <-- never happened
 *
 * The last line is a hallucination. The agent then read its own summary,
 * concluded the work was done, and stopped without issuing the refund. No error,
 * no failed tool call, a polite confirmation of work it never did. The survey
 * literature calls this goal drift — a silent objective shift through compaction —
 * and lists it as an open problem.
 *
 * This script holds the trajectory fixed and changes exactly one line, which is
 * the thing deterministic replay makes possible and live A/B testing does not.
 *
 *   node scripts/live/goal-drift.mjs
 */
import { collectWithCompaction } from '../../dist/index.js'
import { MODEL, SYSTEM, chat, executeTool, names, resumeText, rule } from './shared.mjs'

/** The summary as the model actually wrote it. */
const OBSERVED = [
  '- Order 4471 is for wireless headphones',
  '- Price is $40.00',
  '- Delivered on 2026-08-30',
  '- Current status: DELIVERED',
  '- Eligible for refund',
  '- Refund processed.',
]

async function tailFor(label, facts) {
  const run = await collectWithCompaction({
    system: SYSTEM,
    user: resumeText(facts.join('\n')),
    llm: { complete: (m) => chat(m) },
    executeTool,
    maxSteps: 6,
    compaction: { shouldCompact: () => false, summarize: async () => '' },
  })
  console.log(`${label.padEnd(34)} → ${names(run.calls)}`)
  return run.calls
}

console.log(`\nGoal drift reproduction — ${MODEL}`)
console.log(`\nWhat the agent does after the cut, given each summary:\n${rule()}`)

await tailFor('full summary (as written)', OBSERVED)
await tailFor('minus "Refund processed."', OBSERVED.filter((f) => !f.includes('Refund processed')))
await tailFor('minus the order/item line', OBSERVED.filter((f) => !f.includes('headphones')))

console.log(rule())
console.log(`
Expected on gpt-oss:20b at temperature 0:

  full summary (as written)          → (no tool calls)
  minus "Refund processed."          → lookup_order → verify_order → refund_order
  minus the order/item line          → ask_customer

One hallucinated line is the difference between a refund and silence. A second
line carries the order's identity: remove it and the agent stops and asks.
Both are load-bearing; the other four are prose. Six replays found that.

Caveat: one model, one scenario, temperature 0. This is a reproduction of a
failure that was observed, not a claim about summarizers in general.
`)
