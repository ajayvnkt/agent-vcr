/**
 * @fileoverview `init-check`: scaffold a working check for a project in one command.
 *
 * It writes a policy file, a suite file, a first run to judge and a GitHub
 * Actions workflow, then runs the check so the first verdict is on screen
 * straight away. It refuses to run where a check is already set up.
 *
 * The policy is built from rules the user names. There is deliberately no
 * placeholder policy: a starter file with made-up tool names would pass every
 * run of a real agent and look like protection. Three common shapes cover most
 * first policies.
 *
 * - verify before acting      `--require refund_order:verify_order`
 * - no destructive tools      `--forbid delete_account,drop_table`
 * - call budget               `--max-calls 20 --max-per-tool 3`
 *
 * With `--from` the first run is a real one (an Agent VCR trace or an exported
 * OpenTelemetry span file). Without it, an example run is generated from the
 * policy and labelled as an example, so the scaffold works before any agent has
 * been instrumented.
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TraceAssertion } from './assert.js'
import { assertTrace } from './assert.js'
import { policyHasRules } from './behavior.js'
import { parsePolicyFile } from './behavior-io.js'
import { parseExactArguments } from './replay-identity.js'
import { parseTraceFileV1 } from './schema.js'
import type { ToolCallRecord } from './types.js'
import { parseOtelExport, traceFromOtelSpans } from './adapters/otel.js'

export type StarterPolicyOptions = {
  /** `[dependent, prerequisite]` pairs: wherever the first is called, the second must already have been. */
  require?: [string, string][]
  /** Tools that must never be called. */
  forbid?: string[]
  maxCalls?: number
  maxCallsPerTool?: number
}

/** Build a policy from named rules. Throws when no rule is given, or a rule contradicts another. */
export function buildStarterPolicy(options: StarterPolicyOptions): TraceAssertion {
  const policy: TraceAssertion = {}
  if (options.require?.length) {
    const seen = new Set<string>()
    policy.requires = options.require.filter(([d, p]) => !seen.has(`${d}\u0000${p}`) && seen.add(`${d}\u0000${p}`))
  }
  if (options.forbid?.length) policy.forbid = [...new Set(options.forbid)]
  if (options.maxCalls !== undefined) policy.maxCalls = options.maxCalls
  if (options.maxCallsPerTool !== undefined) policy.maxCallsPerTool = options.maxCallsPerTool
  if (!policyHasRules(policy)) {
    throw new Error('no rules given. Name at least one: --require <action>:<prerequisite>, --forbid <tool>, --max-calls <n> or --max-per-tool <n>')
  }
  for (const [dependent, prerequisite] of policy.requires ?? []) {
    if (dependent === prerequisite) throw new Error(`--require ${dependent}:${prerequisite}: a tool cannot be its own prerequisite`)
    for (const name of [dependent, prerequisite]) {
      if (policy.forbid?.includes(name)) throw new Error(`"${name}" is both required by a rule and forbidden`)
    }
  }
  for (const key of ['maxCalls', 'maxCallsPerTool'] as const) {
    const n = policy[key]
    if (n !== undefined && !Number.isSafeInteger(n)) throw new Error(`${key} must be a whole number a JSON file can hold exactly`)
  }
  requiresOrder(policy.requires ?? []) // throws on a cycle: no run could satisfy such rules
  // Validate through the same gate a policy file goes through, so the scaffold cannot write a file `check` would refuse.
  return parsePolicyFile(JSON.parse(JSON.stringify(policy)) as unknown, 'starter policy')
}

/**
 * Tools named by `requires` rules that never appear in the given runs.
 *
 * A requires rule whose action never occurs can never fire. That is usually a
 * misspelt tool name, and it is silent: the check passes. Forbidden tools are
 * left out, because not appearing is what a forbid rule wants.
 */
export function unexercisedRuleTools(policy: TraceAssertion, runs: ToolCallRecord[][]): string[] {
  const seen = new Set(runs.flatMap((calls) => calls.map((c) => c.name)))
  const named = new Set((policy.requires ?? []).flat())
  return [...named].filter((n) => !seen.has(n)).sort()
}

/** The tools named by requires rules, prerequisites first. Throws when the rules form a cycle. */
function requiresOrder(pairs: [string, string][]): string[] {
  const order: string[] = []
  const pending = new Set(pairs.flat())
  while (pending.size > 0) {
    // Chained rules (c needs b, b needs a) come out in an order a run could follow.
    const ready = [...pending].find((n) => pairs.filter(([d]) => d === n).every(([, p]) => !pending.has(p)))
    if (ready === undefined) throw new Error('the --require rules form a cycle, so no run can satisfy them')
    order.push(ready)
    pending.delete(ready)
  }
  return order
}

/** A minimal run that satisfies the policy, for the example scenario. Throws when the rules leave no room for one. */
function exampleRun(policy: TraceAssertion): ToolCallRecord[] {
  const names = requiresOrder(policy.requires ?? [])
  if (names.length === 0) {
    let placeholder = 'example_tool'
    while (policy.forbid?.includes(placeholder)) placeholder += '_'
    names.push(placeholder)
  }
  const calls = names.map((name): ToolCallRecord => ({ name, args: {} }))
  const failures = assertTrace(calls, policy)
  if (failures.length > 0) {
    // For example a call budget smaller than the rules need. Better to say so than to scaffold a check that fails on its own example.
    throw new Error(`these rules leave no room for even a minimal run (${failures[0]!.message}). Loosen the budget, or give a real run with --from.`)
  }
  return calls
}

export type ScaffoldOptions = StarterPolicyOptions & {
  /** Project directory. Default: current directory. */
  dir?: string
  /** A real run to judge first: an Agent VCR trace file or an exported OpenTelemetry span file. */
  from?: string
  traceId?: string
  namesOnly?: boolean
}

export type ScaffoldResult = {
  created: string[]
  /** Files left alone because they already exist. Only the workflow file can be here. */
  skipped: string[]
  suitePath: string
  /** True when the first scenario is a generated example, not a real run. */
  example: boolean
  /** Tools named by requires rules that the first run never calls. */
  unexercised: string[]
}

const WORKFLOW = `name: Agent checks

on:
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      # Pin this to a commit SHA once you depend on it.
      - uses: ajayvnkt/agent-vcr@main
        with:
          suite: agent-vcr.suite.json
`

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Read a run from a trace file or a span file, whichever the file turns out to be. */
async function loadRun(path: string, options: ScaffoldOptions): Promise<ToolCallRecord[]> {
  const text = await readFile(path, 'utf8')
  let loose: unknown
  try {
    loose = JSON.parse(text)
  } catch {
    loose = undefined
  }
  // A JSON object with "calls" or "version" is meant as a trace file. Report its own problem
  // instead of falling through to the span reader, which would only say it found no spans.
  if (loose !== null && typeof loose === 'object' && !Array.isArray(loose) && ('calls' in loose || 'version' in loose)) {
    if (options.traceId !== undefined || options.namesOnly) {
      throw new Error(`${path} is an Agent VCR trace file; --trace-id and --names-only apply to OpenTelemetry span files only`)
    }
    let exact: unknown
    try {
      exact = parseExactArguments(text)
    } catch (e) {
      throw new Error(`${path}: not a usable trace file: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      return (parseTraceFileV1(exact) as { calls: ToolCallRecord[] }).calls
    } catch {
      throw new Error(`${path}: looks like an Agent VCR trace file but does not match trace schema version 1 ({ "version": 1, "calls": [{ "name", "args" }] })`)
    }
  }
  const otel = traceFromOtelSpans(parseOtelExport(text), {
    traceId: options.traceId,
    missingArguments: options.namesOnly ? 'empty' : 'error',
  })
  if (otel.calls.length === 0) {
    throw new Error(`${path}: not an Agent VCR trace file, and it contains no OpenTelemetry tool spans`)
  }
  return otel.calls
}

/** Write the scaffold. Existing files are never overwritten. */
export async function scaffoldCheck(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const dir = options.dir ?? '.'
  const policy = buildStarterPolicy(options)

  const example = options.from === undefined
  const calls = example ? exampleRun(policy) : await loadRun(options.from!, options)
  const tracePath = example ? 'traces/example.run.json' : 'traces/first.run.json'
  const scenario = example ? 'example run (replace with a real one)' : 'first run'

  const files: [string, string][] = [
    ['policy.json', `${JSON.stringify(policy, null, 2)}\n`],
    [tracePath, `${JSON.stringify({ version: 1, scenario, calls }, null, 2)}\n`],
    [
      'agent-vcr.suite.json',
      `${JSON.stringify({ version: 1, policy: 'policy.json', scenarios: [{ name: scenario, trace: tracePath }] }, null, 2)}\n`,
    ],
    ['.github/workflows/agent-checks.yml', WORKFLOW],
  ]

  // An existing policy, suite or run file means a check is already set up here. Writing around
  // it would leave the rules from this command line unenforced while the first check still
  // passed, so refuse before writing anything. Only the workflow file may already exist.
  const clash: string[] = []
  for (const [rel] of files.slice(0, 3)) if (await exists(join(dir, rel))) clash.push(rel)
  if (clash.length > 0) {
    throw new Error(
      `${clash.join(', ')} already exist${clash.length === 1 ? 's' : ''} in ${dir}, so a check is already set up there. ` +
        'Nothing was written. Edit policy.json and the suite directly, or scaffold into an empty directory with --dir.',
    )
  }
  // Create every directory before the first file, so a failure here leaves no partial scaffold.
  for (const [rel] of files) await mkdir(dirname(join(dir, rel)), { recursive: true })

  const created: string[] = []
  const skipped: string[] = []
  for (const [rel, body] of files) {
    const full = join(dir, rel)
    try {
      // 'wx' fails if the path exists, including as a dangling symlink, so nothing is written through one.
      await writeFile(full, body, { encoding: 'utf8', flag: 'wx' })
      created.push(rel)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      skipped.push(rel)
    }
  }

  return {
    created,
    skipped,
    suitePath: join(dir, 'agent-vcr.suite.json'),
    example,
    unexercised: example ? [] : unexercisedRuleTools(policy, [calls]),
  }
}
