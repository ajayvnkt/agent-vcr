/**
 * @fileoverview The paid tier — a pluggable judge, and the gate that keeps it cheap.
 *
 * Four things can be checked about an agent run, and they differ in cost by
 * about three orders of magnitude:
 *
 *   1. structural  — did it call the right tools in the right order?   free
 *   2. assertions  — right arguments, nothing forbidden, no runaway?   free
 *   3. semantic    — is the final text close enough to the reference?  ~$0.00004
 *   4. judge       — is this actually a good answer?                   ~$0.01
 *
 * The rule that makes a suite affordable: **never spend a higher tier on a run
 * that already failed a lower one.** A run that called `refund_order` before
 * `verify_order` is broken; paying a model to grade its prose tells you nothing
 * you didn't know and costs real money on every commit.
 *
 * So the judge is optional, injected, and gated. With no judge configured the
 * suite is fully deterministic and free — which is what runs on every push. The
 * judge runs nightly, or on demand, or never.
 */

import type { ToolCallRecord } from './types.js'

export type JudgeInput = {
  /** What the user asked on this turn. */
  user: string
  /** The agent's final text. */
  output: string | null
  /** Tool calls made on this turn, for context. */
  calls: ToolCallRecord[]
  /** The rubric this turn should be graded against. */
  rubric: string
}

export type JudgeVerdict = {
  /** 0..1. */
  score: number
  pass: boolean
  reason: string
}

export type Judge = {
  name: string
  evaluate: (input: JudgeInput) => Promise<JudgeVerdict>
}

/** Text checks that cost nothing — tier 3 without the embedding bill. */
export type OutputAssertion = {
  contains?: string[]
  notContains?: string[]
  /** Regular expression source, tested case-insensitively. */
  matches?: string
  /** Fail when the agent produced no final text at all. */
  required?: boolean
}

/** Run the free output checks. Returns human-readable failures. */
export function assertOutput(output: string | null, assertion: OutputAssertion): string[] {
  const failures: string[] = []

  if (output === null || output.trim() === '') {
    if (assertion.required || assertion.contains?.length || assertion.matches) {
      failures.push('expected a final assistant message, got none')
    }
    return failures
  }

  const haystack = output.toLowerCase()
  for (const needle of assertion.contains ?? []) {
    if (!haystack.includes(needle.toLowerCase())) {
      failures.push(`output should contain "${needle}"`)
    }
  }
  for (const needle of assertion.notContains ?? []) {
    if (haystack.includes(needle.toLowerCase())) {
      failures.push(`output should not contain "${needle}"`)
    }
  }
  if (assertion.matches) {
    let re: RegExp
    try {
      re = new RegExp(assertion.matches, 'i')
    } catch {
      throw new Error(`assertOutput: invalid regex /${assertion.matches}/`)
    }
    if (!re.test(output)) failures.push(`output should match /${assertion.matches}/`)
  }

  return failures
}

/**
 * A judge that never calls a model: it passes when the output contains all of
 * the rubric's `expect:` keywords.
 *
 * This exists so a suite written against the judge interface runs in CI, in
 * tests, and on a plane, without an API key. It is not a substitute for a real
 * judge — it cannot assess quality, only presence.
 */
export function keywordJudge(options?: { threshold?: number }): Judge {
  const threshold = options?.threshold ?? 1
  return {
    name: 'keyword',
    evaluate: async ({ output, rubric }) => {
      const keywords = [...rubric.matchAll(/expect:\s*([^\n;]+)/gi)].map((m) => m[1]!.trim())
      if (keywords.length === 0) {
        return { score: 1, pass: true, reason: 'no expect: clauses in rubric — nothing to check' }
      }
      const text = (output ?? '').toLowerCase()
      const hits = keywords.filter((k) => text.includes(k.toLowerCase()))
      const score = hits.length / keywords.length
      return {
        score,
        pass: score >= threshold,
        reason:
          score === 1
            ? `all ${keywords.length} expected phrases present`
            : `missing: ${keywords.filter((k) => !hits.includes(k)).join(', ')}`,
      }
    },
  }
}

/**
 * Wrap any chat completion function as a judge.
 *
 * The prompt asks for one JSON object and nothing else, and the parser is
 * forgiving of the fenced-code-block habit most models have. A malformed reply
 * fails closed with score 0 rather than throwing — a flaky judge should mark a
 * test unresolved, not crash the run.
 */
export function llmJudge(
  complete: (prompt: string) => Promise<string>,
  options?: { name?: string; threshold?: number },
): Judge {
  const threshold = options?.threshold ?? 0.7
  return {
    name: options?.name ?? 'llm',
    evaluate: async ({ user, output, calls, rubric }) => {
      const prompt = [
        'You are grading one turn of an AI agent against a rubric.',
        'Reply with exactly one JSON object: {"score": <0..1>, "reason": "<one sentence>"}',
        '',
        `USER ASKED: ${user}`,
        `TOOLS CALLED: ${calls.map((c) => c.name).join(' → ') || '(none)'}`,
        `AGENT REPLIED: ${output ?? '(no final message)'}`,
        '',
        `RUBRIC: ${rubric}`,
      ].join('\n')

      const raw = await complete(prompt)
      const parsed = parseVerdict(raw)
      if (parsed === null) {
        return { score: 0, pass: false, reason: `judge returned unparseable output: ${trim(raw)}` }
      }
      return { score: parsed.score, pass: parsed.score >= threshold, reason: parsed.reason }
    },
  }
}

function trim(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > 160 ? `${one.slice(0, 157)}...` : one
}

function parseVerdict(raw: string): { score: number; reason: string } | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1]! : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const v = JSON.parse(body.slice(start, end + 1)) as { score?: unknown; reason?: unknown }
    const score = typeof v.score === 'number' ? v.score : Number(v.score)
    if (!Number.isFinite(score)) return null
    return {
      score: Math.max(0, Math.min(1, score)),
      reason: typeof v.reason === 'string' ? v.reason : '(no reason given)',
    }
  } catch {
    return null
  }
}
