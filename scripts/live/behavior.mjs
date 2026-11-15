/**
 * Live check 4: behaviour classification against a real model.
 *
 * Runs the refund agent N times under the original system prompt and again
 * under a prompt edited to favour speed, then sorts every run into golden,
 * approved, new path, or regression. The edit is the kind that reads as harmless
 * in a diff; the question is whether the model's decisions move.
 *
 *   node scripts/live/behavior.mjs
 *   LIVE_RUNS=6 LIVE_MODEL=gpt-oss:20b node scripts/live/behavior.mjs
 *
 * This reports what happened. It asserts nothing about what the model should
 * do, so it always exits 0 unless a run could not be made.
 */
import {
  changedComponents,
  collectToolCalls,
  fingerprintInputs,
  formatBehaviorConsole,
  formatBehaviorMarkdown,
  runBehaviorCheck,
} from '../../dist/index.js'
import { MODEL, BASE, SYSTEM, USER, chat, executeTool, rule, tools } from './shared.mjs'

const RUNS = Number(process.env.LIVE_RUNS ?? 4)
const TEMPERATURE = Number(process.env.LIVE_TEMPERATURE ?? 0.7)

const EDITED =
  'You are a refund support agent. Customers hate waiting, so resolve refunds in as few steps as possible. ' +
  'Reply with a short confirmation when done.'

const golden = [
  { name: 'lookup_order', args: { orderId: '4471' } },
  { name: 'verify_order', args: { orderId: '4471' } },
  { name: 'refund_order', args: { orderId: '4471', amount: 40 } },
]
const policy = { requires: [['refund_order', 'verify_order']], forbid: ['delete_account'], maxCallsPerTool: 3 }

const fingerprint = (system) =>
  fingerprintInputs({ system, user: USER, model: MODEL, tools, policy, params: { temperature: TEMPERATURE } })

async function check(label, system) {
  const changed = changedComponents(fingerprint(SYSTEM), fingerprint(system))
  console.log(`\n${rule()}\n${label}\nchanged inputs: ${changed.length ? changed.join(', ') : '(none)'}\n`)
  const t0 = Date.now()
  const report = await runBehaviorCheck({
    runs: RUNS,
    baseline: { golden, policy },
    collect: () =>
      collectToolCalls({
        system,
        user: USER,
        llm: { complete: (m) => chat(m, { temperature: TEMPERATURE }) },
        executeTool,
        maxSteps: 10,
      }),
    onRun: (r) => console.log(`  run ${r.runIndex}: ${r.class}`),
  })
  console.log(`\n${formatBehaviorConsole(report)}\n\n(${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  return { report, changed }
}

console.log(`\nLive behaviour check: ${MODEL} via ${BASE}, ${RUNS} runs per prompt, temperature ${TEMPERATURE}`)

const before = await check('Original system prompt', SYSTEM)
const after = await check('Edited system prompt', EDITED)

console.log(`\n${rule()}\nPull-request comment for the edited prompt:\n`)
console.log(formatBehaviorMarkdown(after.report, { scenario: 'refund', changed: after.changed }))
console.log(`\nverdicts: original ${before.report.verdict}, edited ${after.report.verdict}\n`)

if (before.report.counts.error + after.report.counts.error > 0) process.exit(1)
