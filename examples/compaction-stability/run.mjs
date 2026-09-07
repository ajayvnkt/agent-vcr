/**
 * Compaction stability + summary ablation, with no live model and no API key.
 *
 * A support agent runs long enough to compact its own context. The summarizer is
 * lossy: some of the time it drops the order id. Nothing else changes between runs.
 *
 * Part 1 measures what that does to run-to-run consistency, and how much of the
 * variance sits within a few calls of a cut.
 * Part 2 removes one fact from the summary at a time and replays the tail, to find
 * which facts the downstream behaviour actually depends on.
 *
 * Run from repo root: npm run example:compaction-stability
 */

import {
  ablateSummary,
  analyzeStability,
  assistantText,
  assistantWithTools,
  collectWithCompaction,
  compactAtTokenBudget,
  toolCall,
} from '../../dist/index.js'

const ORDER_ID = '4471'

/** Deterministic PRNG so the example reproduces exactly. */
function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A stand-in agent. Before compaction it works through the ticket; after
 * compaction it can only issue the refund if the order id survived the cut.
 */
function makeAgent() {
  let step = 0
  let verified = false
  let refunded = false
  let searched = false
  return async (messages) => {
    step++
    const context = messages
      .map((m) => [m.content ?? '', ...(m.tool_calls ?? []).map((t) => t.function.name)].join(' '))
      .join('\n')
    const compacted = context.includes('context was compacted')

    if (!compacted) {
      if (step === 1) return assistantWithTools([toolCall('open_ticket', { id: 'T-9' }, 'c1')])
      if (step === 2) return assistantWithTools([toolCall('read_thread', { id: 'T-9' }, 'c2')])
      if (step === 3) return assistantWithTools([toolCall('read_policy', { doc: 'refunds' }, 'c3')])
      return assistantWithTools([toolCall('read_history', { user: 'u-22' }, 'c4')])
    }

    // The one thing that varies: did the order id survive the cut?
    if (context.includes(ORDER_ID)) {
      if (!verified) {
        verified = true
        return assistantWithTools([toolCall('verify_order', { orderId: ORDER_ID }, 'c5')])
      }
      if (!refunded) {
        refunded = true
        return assistantWithTools([
          toolCall('refund_order', { orderId: ORDER_ID, amount: 40 }, 'c6'),
        ])
      }
      return assistantText('Refunded $40 on order 4471.')
    }

    // It didn't, so the agent has to go and re-find it — and then gives up.
    if (!searched) {
      searched = true
      return assistantWithTools([toolCall('search_orders', { user: 'u-22' }, 'c7')])
    }
    return assistantText('I could not confirm which order to refund.')
  }
}

/** Lossy summarizer: `dropIdChance` of the time it forgets to carry the order id. */
function makeSummarizer(rand, dropIdChance) {
  return async () => {
    const facts = [
      'customer u-22 opened ticket T-9 asking for a refund',
      'refund policy allows refunds within 30 days',
      'customer has 3 prior orders, no prior refunds',
      'customer was polite throughout',
    ]
    if (rand() >= dropIdChance) facts.splice(1, 0, `the order in question is ${ORDER_ID}`)
    return facts.join('\n')
  }
}

async function oneRun(rand, dropIdChance) {
  return collectWithCompaction({
    system: 'You are a support agent. Verify the order before refunding.',
    user: 'Refund the customer for their damaged item.',
    llm: { complete: makeAgent() },
    executeTool: async () => 'x'.repeat(3000),
    maxSteps: 12,
    compaction: {
      shouldCompact: compactAtTokenBudget(2000),
      summarize: makeSummarizer(rand, dropIdChance),
      keepRecentTurns: 1,
    },
  })
}

// ── Part 1 — stability across runs ────────────────────────────────────────────

const rand = mulberry32(7)
const runs = []
for (let i = 0; i < 12; i++) runs.push(await oneRun(rand, 0.35))

const report = analyzeStability(runs, { attributionWindow: 3 })

console.log('\n── Stability ─────────────────────────────────────────────')
console.log(`verdict                 ${report.verdict}`)
console.log(`runs                    ${report.runs}`)
console.log(`distinct traces         ${report.distinctTraces}`)
console.log(`modal share             ${Math.round(report.modalShare * 100)}%`)
console.log(
  `attributable to a cut   ${Math.round(report.compactionAttributableShare * 100)}% of diverging runs`,
)
console.log(`first-divergence calls  ${JSON.stringify(report.divergenceHistogram)}`)
console.log(`\n${report.summary}\n`)

// ── Part 2 — which summary facts are load-bearing ─────────────────────────────

const baselineRun = runs.find((r) => r.calls.some((c) => c.name === 'refund_order'))
if (!baselineRun) throw new Error('no successful run to ablate against')

const cut = baselineRun.compactions[0]
const cutAt = cut.atCall
const baselineTail = baselineRun.calls.slice(cutAt)

/** Resume from the cut with a mutated summary and return only the calls that follow. */
async function replayTail(mutatedSummary) {
  const run = await collectWithCompaction({
    system: 'You are a support agent. Verify the order before refunding.',
    user: 'Refund the customer for their damaged item.',
    llm: { complete: makeAgent() },
    executeTool: async () => 'x'.repeat(3000),
    maxSteps: 12,
    compaction: {
      shouldCompact: compactAtTokenBudget(2000),
      summarize: async () => mutatedSummary,
      keepRecentTurns: 1,
    },
  })
  return run.calls.slice(run.compactions[0]?.atCall ?? 0)
}

const ablation = await ablateSummary({
  baseline: baselineTail,
  summary: cut.summary,
  replay: replayTail,
})

console.log('── Summary ablation ──────────────────────────────────────')
for (const f of ablation.facts) {
  console.log(`${f.loadBearing ? 'LOAD-BEARING' : 'droppable   '}  ${f.fact}`)
}
console.log('\nMinimal summary that preserves behaviour:')
console.log(ablation.compactionSchema || '(none)')
console.log(`\n${ablation.summary}\n`)
