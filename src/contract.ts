/**
 * @fileoverview Summary contracts — the compaction schema as a committed, enforceable file.
 *
 * `ablateSummary` produces a finding: these facts changed downstream behaviour
 * when removed, the rest did not. A finding decays. Six weeks later someone
 * lowers the token budget to cut costs, the summary gets terser, the order id
 * falls out, and the agent starts asking customers for information it already
 * had. The tests pass. The model still sounds fine.
 *
 * A contract is that finding written down and checked on every run. It turns
 * "we measured which facts matter" into "CI fails when one goes missing" — which
 * is the only form of knowledge that survives a team.
 *
 * The check is deliberately shallow: substring and regex, no model, no
 * embeddings. A contract that needs a judge to evaluate cannot run on every
 * commit, and a check that cannot run on every commit is documentation.
 */

import type { AblationReport } from './ablation.js'
import type { CompactionEvent } from './compaction.js'

export type ContractFact = {
  /** Stable id so a report can reference a fact after the wording changes. */
  id: string
  /** What the summary must carry. Matched as a case-insensitive substring by default. */
  must: string
  /** Treat `must` as a regular expression instead of a substring. */
  regex?: boolean
  /** Why this fact matters — shown when the check fails. */
  because?: string
}

export type SummaryContract = {
  version: 1
  scenario: string
  facts: ContractFact[]
  /** How the contract was produced, for provenance. */
  derivedFrom?: 'ablation' | 'manual'
  /** Optional ceiling on summary length, in the estimator's token units. */
  maxSummaryTokens?: number
}

export type ContractViolation = {
  factId: string
  must: string
  because?: string
  kind: 'missing' | 'tooLong'
  message: string
}

export type ContractResult = {
  ok: boolean
  scenario: string
  checked: number
  violations: ContractViolation[]
  message: string
}

function slugify(text: string, index: number): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return base.length > 0 ? base : `fact-${index + 1}`
}

/**
 * Turn an ablation report into a contract.
 *
 * Only load-bearing facts become clauses. The droppable ones are left out on
 * purpose: a contract that pins prose will fail on a summary that got better.
 */
export function contractFromAblation(
  scenario: string,
  report: AblationReport,
  options?: { maxSummaryTokens?: number },
): SummaryContract {
  return {
    version: 1,
    scenario,
    derivedFrom: 'ablation',
    maxSummaryTokens: options?.maxSummaryTokens,
    facts: report.loadBearing.map((fact, i) => ({
      id: slugify(fact, i),
      must: fact,
      because: 'removing this changed downstream tool calls during ablation',
    })),
  }
}

/**
 * Check one summary against a contract.
 *
 * Substring matching is intentionally literal, and that is a real limitation: a
 * summary that says "order #4471" satisfies a `must` of "4471" but not one of
 * "the order in question is 4471". Write clauses around the *identifier* rather
 * than the sentence, and use `regex` when a value can be phrased several ways.
 */
export function verifySummary(
  summary: string,
  contract: SummaryContract,
  options?: { estimateTokens?: (text: string) => number },
): ContractResult {
  const violations: ContractViolation[] = []
  const haystack = summary.toLowerCase()

  for (const fact of contract.facts) {
    let present: boolean
    if (fact.regex) {
      try {
        present = new RegExp(fact.must, 'i').test(summary)
      } catch {
        throw new Error(`verifySummary: fact "${fact.id}" has an invalid regex: ${fact.must}`)
      }
    } else {
      present = haystack.includes(fact.must.toLowerCase())
    }
    if (!present) {
      violations.push({
        factId: fact.id,
        must: fact.must,
        because: fact.because,
        kind: 'missing',
        message: `summary is missing required fact "${fact.id}": ${fact.must}`,
      })
    }
  }

  if (contract.maxSummaryTokens !== undefined) {
    const estimate = options?.estimateTokens ?? ((t: string) => Math.ceil(t.length / 4))
    const size = estimate(summary)
    if (size > contract.maxSummaryTokens) {
      violations.push({
        factId: '__length__',
        must: `<= ${contract.maxSummaryTokens} tokens`,
        kind: 'tooLong',
        message: `summary is ~${size} tokens, contract allows ${contract.maxSummaryTokens}`,
      })
    }
  }

  const ok = violations.length === 0
  return {
    ok,
    scenario: contract.scenario,
    checked: contract.facts.length,
    violations,
    message: ok
      ? `summary satisfies all ${contract.facts.length} clauses of "${contract.scenario}"`
      : `summary breaks ${violations.length} of ${contract.facts.length} clauses of "${contract.scenario}": ${violations.map((v) => v.factId).join(', ')}`,
  }
}

/**
 * Check every compaction in a run.
 *
 * A run that compacts six times has six chances to drop a load-bearing fact, and
 * one bad cut is enough to derail everything after it — so every cut is checked,
 * not just the first.
 */
export function verifyRunContract(
  compactions: CompactionEvent[],
  contract: SummaryContract,
  options?: { estimateTokens?: (text: string) => number },
): { ok: boolean; results: (ContractResult & { atCall: number })[]; message: string } {
  const results = compactions.map((c) => ({
    ...verifySummary(c.summary, contract, options),
    atCall: c.atCall,
  }))
  const bad = results.filter((r) => !r.ok)
  return {
    ok: bad.length === 0,
    results,
    message:
      compactions.length === 0
        ? 'no compactions occurred, contract not exercised'
        : bad.length === 0
          ? `all ${compactions.length} compactions satisfied the contract`
          : `${bad.length} of ${compactions.length} compactions broke the contract (first at call ${bad[0]!.atCall})`,
  }
}
