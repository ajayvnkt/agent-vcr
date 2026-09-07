/**
 * Live check 2 — summary ablation against a real model.
 *
 * Run the agent until it compacts. Keep the summary it wrote and the calls it
 * made afterwards; that pair is the baseline. Then remove one fact from the
 * summary, resume from the cut against the same model, and diff what follows.
 *
 * Facts whose removal changes behaviour are load-bearing. The rest are prose.
 *
 *   node scripts/live/ablation.mjs
 */
import { ablateSummary, collectWithCompaction, compactAtTokenBudget } from '../../dist/index.js'
import { MODEL, SYSTEM, USER, chat, executeTool, names, resumeText, rule, summarize } from './shared.mjs'

console.log(`\nLive ablation — ${MODEL}\n${rule()}`)

// ── Baseline: one real run, up to and past its first compaction ───────────────
const baseRun = await collectWithCompaction({
  system: SYSTEM,
  user: USER,
  llm: { complete: (m) => chat(m) },
  executeTool,
  maxSteps: 10,
  compaction: {
    shouldCompact: compactAtTokenBudget(1200),
    // Nothing kept verbatim: the summary is the only thing carrying the past,
    // which is what makes its contents measurable.
    keepRecentTurns: 0,
    summarize,
  },
})

const cut = baseRun.compactions[0]
if (!cut) {
  console.log('No compaction fired — nothing to ablate. Lower the budget and retry.')
  process.exit(0)
}

const baseline = baseRun.calls.slice(cut.atCall)

console.log(`full trace  : ${names(baseRun.calls)}`)
console.log(`cut at call : ${cut.atCall}  (${cut.tokensBefore} → ${cut.tokensAfter} est. tokens)`)
console.log(`baseline tail after the cut: ${names(baseline)}`)
console.log(`\nsummary the model wrote:\n${cut.summary}\n${rule()}`)

// ── Replay the tail with one fact removed ─────────────────────────────────────
let replays = 0
async function replayTail(mutatedSummary) {
  replays++
  const run = await collectWithCompaction({
    system: SYSTEM,
    user: resumeText(mutatedSummary),
    llm: { complete: (m) => chat(m) },
    executeTool,
    maxSteps: 8,
    // No further cuts: we are measuring this tail, not generating new ones.
    compaction: { shouldCompact: () => false, summarize: async () => '' },
  })
  return run.calls
}

const report = await ablateSummary({ baseline, summary: cut.summary, replay: replayTail })

for (const f of report.facts) {
  console.log(`${f.loadBearing ? 'LOAD-BEARING' : 'droppable   '}  ${f.fact.slice(0, 78)}`)
}

console.log(`\nreplays: ${replays}`)
console.log(`\nMinimal summary that preserves behaviour:\n${report.compactionSchema || '(none)'}`)
console.log(`\n${report.summary}\n`)
