/**
 * Example: Financial Transfer Agent
 *
 * A high-stakes agent that validates a transfer before executing it.
 * Skipping balance or limit checks in prod = real money lost.
 * Agent VCR guarantees the verification sequence is always called.
 *
 * Run: npm run example:financial-transfer
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
const goldenPath = join(__dirname, 'traces', 'transfer-happy-path.expected.json')

const SYSTEM = `You are a secure financial transfer agent.
ALWAYS follow this sequence — never skip a step:
1. get_account_balance — verify the source account has sufficient funds
2. check_transfer_limit — verify the amount is within daily limits
3. execute_transfer — only after both checks pass

If either check fails, call reject_transfer instead of execute_transfer.`

// ── Scripted LLM ──────────────────────────────────────────────────────────────

const transferRequest = {
  fromAccountId: 'acc_123',
  toAccountId: 'acc_456',
  amountCents: 50000,
  memo: 'Rent payment',
}

const llm = new ScriptedLlm([
  assistantWithTools([
    toolCall('get_account_balance', { accountId: transferRequest.fromAccountId }, 'c1'),
  ]),
  assistantWithTools([
    toolCall('check_transfer_limit', {
      accountId: transferRequest.fromAccountId,
      amountCents: transferRequest.amountCents,
    }, 'c2'),
  ]),
  assistantWithTools([
    toolCall('execute_transfer', {
      fromAccountId: transferRequest.fromAccountId,
      toAccountId: transferRequest.toAccountId,
      amountCents: transferRequest.amountCents,
      memo: transferRequest.memo,
    }, 'c3'),
  ]),
  assistantText('Transfer of $500.00 to acc_456 completed successfully.'),
])

// ── Stub tool backend ─────────────────────────────────────────────────────────

async function executeTool(name, args) {
  if (name === 'get_account_balance') {
    return { accountId: args.accountId, balanceCents: 250000, currency: 'USD' }
  }
  if (name === 'check_transfer_limit') {
    return { allowed: true, dailyLimitCents: 500000, usedTodayCents: 0 }
  }
  if (name === 'execute_transfer') {
    return {
      transactionId: 'txn_' + Math.random().toString(36).slice(2, 10),
      status: 'completed',
      amountCents: args.amountCents,
    }
  }
  if (name === 'reject_transfer') {
    return { rejected: true, reason: args.reason }
  }
  throw new Error(`Unknown tool: ${name}`)
}

// ── Regression test: what if a prompt change skips the limit check? ───────────

const badLlm = new ScriptedLlm([
  assistantWithTools([
    toolCall('get_account_balance', { accountId: transferRequest.fromAccountId }, 'c1'),
  ]),
  // BUG: skipped check_transfer_limit — goes straight to execute
  assistantWithTools([
    toolCall('execute_transfer', {
      fromAccountId: transferRequest.fromAccountId,
      toAccountId: transferRequest.toAccountId,
      amountCents: transferRequest.amountCents,
      memo: transferRequest.memo,
    }, 'c2'),
  ]),
  assistantText('Transfer completed.'),
])

const badRecorded = await collectToolCalls({
  system: SYSTEM,
  user: `Transfer $500 from acc_123 to acc_456. Memo: Rent payment`,
  llm: badLlm,
  executeTool,
})

const expected = await loadTraceFile(goldenPath)
const badResult = compareTraces(expected.calls, badRecorded)

if (badResult.ok) {
  console.error('ERROR: regression test should have failed but passed!')
  process.exit(1)
}
console.error(`OK: regression caught — "${badResult.reason}"`)

// ── Happy path ─────────────────────────────────────────────────────────────────

const recorded = await collectToolCalls({
  system: SYSTEM,
  user: `Transfer $500 from acc_123 to acc_456. Memo: Rent payment`,
  llm,
  executeTool,
})

const result = compareTraces(expected.calls, recorded)

if (!result.ok) {
  console.error('TRACE MISMATCH:', result.reason)
  process.exit(1)
}

console.error(`OK: financial-transfer — ${recorded.length} tool calls matched golden trace`)
console.error(`    ${recorded.map((c) => c.name).join(' → ')}`)
