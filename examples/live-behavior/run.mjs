/**
 * Live behaviour checks, demonstrated with no live model and no API key.
 *
 * In real use `collect` runs your agent against a real model. Here three
 * stand-in "models" return fixed runs, so the example is reproducible and shows
 * each verdict:
 *
 *   1. same prompt        every run matches the golden trace          -> unchanged
 *   2. prompt reworded    some runs verify before looking up          -> review
 *   3. prompt "optimised" some runs refund without verifying          -> regression
 *
 * The second case is the one a golden trace alone gets wrong: it fails the
 * build for a path that breaks no rule. The third is the one a replay test
 * cannot see at all, because replay never asks the model.
 *
 * Run from repo root: npm run example:live-behavior
 */

import {
  addVariant,
  changedComponents,
  fingerprintInputs,
  formatBehaviorConsole,
  formatBehaviorMarkdown,
  runBehaviorCheck,
} from '../../dist/index.js'

const call = (name, args = {}) => ({ name, args })
const lookup = call('lookup_order', { orderId: '4471' })
const verify = call('verify_order', { orderId: '4471' })
const refund = call('refund_order', { orderId: '4471', amount: 40 })

const golden = [lookup, verify, refund]
const policy = { requires: [['refund_order', 'verify_order']], forbid: ['delete_account'], maxCallsPerTool: 3 }

const tools = ['lookup_order', 'verify_order', 'refund_order'].map((name) => ({ name }))
const prompts = {
  original: 'You are a refund agent. Always look up and verify an order before refunding it.',
  reworded: 'You are a refund agent. Verify eligibility and look up the order before any refund.',
  optimised: 'You are a refund agent. Refund quickly; customers hate waiting.',
}

/** Stand-ins for a live model: what each prompt produces on run i. */
const models = {
  original: () => golden,
  reworded: (i) => (i % 2 === 0 ? golden : [verify, lookup, refund]),
  optimised: (i) => (i < 3 ? golden : [lookup, refund]),
}

const committed = fingerprintInputs({ system: prompts.original, model: 'demo-model', tools, policy })
let variants = []

async function check(label, promptKey) {
  const current = fingerprintInputs({ system: prompts[promptKey], model: 'demo-model', tools, policy })
  const changed = changedComponents(committed, current)
  console.log(`\n${'─'.repeat(70)}\n${label}`)

  if (changed.length === 0) {
    console.log('fingerprint unchanged: a real pipeline would skip the live runs here. Running anyway to show the result.')
  } else {
    console.log(`fingerprint changed: ${changed.join(', ')} -> live runs are worth making`)
  }

  const report = await runBehaviorCheck({
    runs: 5,
    baseline: { golden, variants, policy },
    collect: async (i) => models[promptKey](i),
  })
  console.log(`\n${formatBehaviorConsole(report)}`)
  return { report, changed }
}

const same = await check('1. Same prompt', 'original')
const reworded = await check('2. Prompt reworded', 'reworded')

// A person reads the new path, decides it is fine, and approves it. Explicitly.
const approved = addVariant(variants, reworded.report.newPaths[0].calls, 'verify-first', {
  note: 'Verifying before the lookup is fine: both happen before the refund.',
})
variants = approved.variants
console.log(`\n-> reviewer approves it: ${approved.reason}`)
const again = await check('2b. Same reworded prompt, after approval', 'reworded')

const optimised = await check('3. Prompt "optimised" for speed', 'optimised')

console.log(`\n${'─'.repeat(70)}\nThe pull-request comment for case 3:\n`)
console.log(
  formatBehaviorMarkdown(optimised.report, {
    scenario: 'refund_happy_path',
    changed: optimised.changed,
  }),
)

const expected = ['unchanged', 'review', 'unchanged', 'regression']
const actual = [same, reworded, again, optimised].map((r) => r.report.verdict)
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error(`\nexpected verdicts ${expected.join(', ')} but got ${actual.join(', ')}`)
  process.exit(1)
}
console.log(`\nverdicts: ${actual.join(' -> ')}`)
