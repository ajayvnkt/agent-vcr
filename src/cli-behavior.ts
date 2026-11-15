/**
 * @fileoverview CLI commands for live behaviour checks.
 *
 * agent-vcr fingerprint --config <record.config.json> [--policy <policy.json>] [--golden <trace.json>]
 *                       [--variants <variants.json>] [--mode <mode>] [--out <file> | --check <file>]
 * agent-vcr behavior    --config <record.config.json> --golden <trace.json> [options]
 * agent-vcr accept      --variants <variants.json> --trace <trace.json> --name <name> [--note <text>] [--policy <policy.json>]
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CompareMode, ToolCallRecord } from './types.js'
import type { RecordConfig } from './record.js'
import type { TraceAssertion } from './assert.js'
import type { Variant } from './variants.js'
import { assertTrace } from './assert.js'
import { recordTrace } from './record.js'
import { loadTraceFile, saveTraceFile } from './trace-io.js'
import { addVariant } from './variants.js'
import { runBehaviorCheck } from './behavior.js'
import { formatBehaviorConsole, formatBehaviorMarkdown } from './behavior-report.js'
import { changedComponents, fingerprintInputs } from './fingerprint.js'
import { parseOtelExport, traceFromOtelSpans } from './adapters/otel.js'
import { runCheck } from './check.js'
import { formatCheckHtml, formatCheckMarkdown } from './check-report.js'
import type { BehaviorFingerprintV1 } from './fingerprint.js'
import {
  loadFingerprintFile,
  loadPolicyFile,
  loadVariantFile,
  saveFingerprintFile,
  saveVariantFile,
} from './behavior-io.js'

/** Exit codes shared by the behaviour commands. */
export const EXIT = { ok: 0, changed: 1, usage: 2 } as const

type Flags = Map<string, string | true>

const BOOLEAN_FLAGS = new Set(['--if-changed', '--strict', '--names-only'])

/** Parse `--flag value` and boolean flags. Unknown or valueless flags are a usage error. */
function parseFlags(args: string[], known: string[]): Flags {
  const flags: Flags = new Map()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!known.includes(a)) throw new UsageError(`unknown option "${a}"`)
    if (BOOLEAN_FLAGS.has(a)) {
      flags.set(a, true)
      continue
    }
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError(`option "${a}" needs a value`)
    flags.set(a, value)
    i++
  }
  return flags
}

export class UsageError extends Error {}

function str(flags: Flags, name: string): string | undefined {
  const v = flags.get(name)
  return typeof v === 'string' ? v : undefined
}

function need(flags: Flags, name: string, command: string): string {
  const v = str(flags, name)
  if (v === undefined) throw new UsageError(`${command}: ${name} is required`)
  return v
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function loadConfig(path: string): Promise<RecordConfig> {
  const raw = await readFile(path, 'utf8')
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (e) {
    throw new Error(`Invalid JSON in ${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${path}: expected an object`)
  const config = data as RecordConfig
  if (typeof config.user !== 'string') throw new Error(`${path}: "user" must be a string`)
  if (!Array.isArray(config.tools)) throw new Error(`${path}: "tools" must be an array`)
  return config
}

/** What a run is judged against. Part of the fingerprint: changing any of it changes the verdict. */
type Judged = { golden?: ToolCallRecord[]; variants?: Variant[]; mode?: CompareMode }

/**
 * Everything that decides what is run or how it is judged.
 *
 * The endpoint is included because the same model name on a different server is
 * a different model. Stubs are included because they are what the model reads
 * back. Golden trace, approved paths and compare mode are included because a
 * check skipped on the strength of a stale baseline would be a false pass.
 */
function configFingerprint(
  config: RecordConfig,
  policy: TraceAssertion | undefined,
  judged: Judged,
): BehaviorFingerprintV1 {
  const extra: Record<string, unknown> = {}
  if (config.stubs !== undefined) extra['stubs'] = config.stubs
  if (judged.golden !== undefined) extra['golden'] = judged.golden
  if (judged.variants !== undefined) extra['variants'] = judged.variants.map((v) => ({ name: v.name, calls: v.calls }))
  if (judged.mode !== undefined) extra['mode'] = judged.mode
  return fingerprintInputs({
    system: config.system,
    user: config.user,
    model: config.model ?? DEFAULT_MODEL,
    tools: config.tools,
    policy,
    params: {
      baseURL: (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
      maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
    },
    extra,
  })
}

// Mirrors the defaults in recordTrace, so an explicit default and an omitted one hash the same.
const DEFAULT_MODEL = 'gpt-4o-mini'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MAX_STEPS = 16

async function loadJudged(flags: Flags): Promise<Judged> {
  const goldenPath = str(flags, '--golden')
  const variantsPath = str(flags, '--variants')
  return {
    golden: goldenPath ? (await loadTraceFile(goldenPath)).calls : undefined,
    variants: variantsPath && (await exists(variantsPath)) ? (await loadVariantFile(variantsPath)).variants : [],
    mode: parseMode(str(flags, '--mode')),
  }
}

function applyOverrides(config: RecordConfig, flags: Flags): void {
  const model = str(flags, '--model')
  const baseURL = str(flags, '--base-url')
  if (model) config.model = model
  if (baseURL) config.baseURL = baseURL
}

export async function cmdFingerprint(args: string[], log: (s: string) => void): Promise<number> {
  const flags = parseFlags(args, ['--config', '--policy', '--golden', '--variants', '--mode', '--out', '--check', '--model', '--base-url'])
  const config = await loadConfig(need(flags, '--config', 'fingerprint'))
  applyOverrides(config, flags)
  const policyPath = str(flags, '--policy')
  const current = configFingerprint(config, policyPath ? await loadPolicyFile(policyPath) : undefined, await loadJudged(flags))

  const checkPath = str(flags, '--check')
  if (checkPath) {
    const changed = changedComponents(await loadFingerprintFile(checkPath), current)
    if (changed.length === 0) {
      log(`unchanged: behaviour inputs match ${checkPath}`)
      return EXIT.ok
    }
    log(`changed: ${changed.join(', ')}`)
    return EXIT.changed
  }

  const outPath = str(flags, '--out')
  if (outPath) {
    await saveFingerprintFile(outPath, current)
    log(`wrote ${outPath} (${Object.keys(current.components).join(', ')})`)
    return EXIT.ok
  }
  process.stdout.write(`${JSON.stringify(current, null, 2)}\n`)
  return EXIT.ok
}

/** Evaluate recorded runs against policy and golden traces; write a report bundle. No model calls. */
export async function cmdCheck(args: string[], log: (s: string) => void): Promise<number> {
  const flags = parseFlags(args, ['--suite', '--out-dir', '--strict'])
  const suitePath = need(flags, '--suite', 'check')
  const report = await runCheck(suitePath, { tool: `agent-vcr@${await ownVersion()}` })

  for (const s of report.scenarios) log(`  ${s.status.padEnd(6)} ${s.name}${s.status === 'pass' ? '' : `: ${s.reason}`}`)
  const c = report.counts
  log(`\n${report.verdict.toUpperCase()}: ${c.pass} passed, ${c.review} to review, ${c.fail} failed, ${c.error} could not be evaluated`)

  const outDir = str(flags, '--out-dir')
  if (outDir) {
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    await writeFile(join(outDir, 'report.md'), `${formatCheckMarkdown(report)}\n`, 'utf8')
    await writeFile(join(outDir, 'report.html'), formatCheckHtml(report), 'utf8')
    log(`wrote ${join(outDir, 'results.json')}, report.md, report.html`)
  }
  if (report.verdict === 'fail') return EXIT.changed
  if (report.verdict === 'review' && flags.has('--strict')) return EXIT.changed
  return EXIT.ok
}

async function ownVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Convert exported OpenTelemetry GenAI spans into a trace file any other command can use. */
export async function cmdFromOtel(args: string[], log: (s: string) => void): Promise<number> {
  const positional = args.length > 0 && !args[0]!.startsWith('--') ? args[0]! : undefined
  if (positional === undefined) throw new UsageError('from-otel: missing <spans.json>')
  const flags = parseFlags(args.slice(1), ['--out', '--trace-id', '--scenario', '--names-only'])
  const input = parseOtelExport(await readFile(positional, 'utf8'))
  const result = traceFromOtelSpans(input, {
    traceId: str(flags, '--trace-id'),
    missingArguments: flags.has('--names-only') ? 'empty' : 'error',
  })
  if (result.calls.length === 0) {
    log(`no execute_tool spans found in ${positional}. The file must contain OpenTelemetry GenAI spans with gen_ai.operation.name = execute_tool.`)
    return EXIT.changed
  }
  const scenario = str(flags, '--scenario')
  const trace = { version: 1 as const, ...(scenario ? { scenario } : {}), calls: result.calls }
  const outPath = str(flags, '--out')
  if (outPath) {
    await saveTraceFile(outPath, trace)
    log(`wrote ${outPath} (${result.calls.length} call${result.calls.length === 1 ? '' : 's'})`)
  } else {
    process.stdout.write(`${JSON.stringify(trace, null, 2)}\n`)
  }
  if (result.withoutArguments > 0) {
    log(`note: ${result.withoutArguments} call(s) had no recorded arguments and were written with {}. Only tool names and order can be checked.`)
  }
  return EXIT.ok
}

export async function cmdAccept(args: string[], log: (s: string) => void): Promise<number> {
  const flags = parseFlags(args, ['--variants', '--trace', '--name', '--note', '--policy', '--mode'])
  const variantsPath = need(flags, '--variants', 'accept')
  const trace = await loadTraceFile(need(flags, '--trace', 'accept'))
  const name = need(flags, '--name', 'accept')
  const mode = parseMode(str(flags, '--mode'))

  const policyPath = str(flags, '--policy')
  if (policyPath) {
    const failures = assertTrace(trace.calls, await loadPolicyFile(policyPath))
    if (failures.length > 0) {
      log(`refused: this path breaks policy and cannot be approved`)
      for (const f of failures) log(`  - ${f.message}`)
      return EXIT.changed
    }
  }

  const file = (await exists(variantsPath))
    ? await loadVariantFile(variantsPath)
    : { version: 1 as const, ...(trace.scenario ? { scenario: trace.scenario } : {}), variants: [] as Variant[] }
  const result = addVariant(file.variants, trace.calls, name, { mode, note: str(flags, '--note') })
  if (!result.added) {
    log(`nothing to do: ${result.reason}`)
    return EXIT.ok
  }
  await saveVariantFile(variantsPath, { ...file, variants: result.variants })
  log(`${result.reason} in ${variantsPath}`)
  if (!policyPath) log('note: no --policy given, so this path was not checked against any rule')
  return EXIT.ok
}

/** Quote a path for a POSIX shell when it contains anything beyond plain path characters. */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

function parseMode(value: string | undefined): CompareMode {
  if (value === undefined) return 'exact'
  if (value !== 'exact' && value !== 'subsequence') throw new UsageError(`unknown mode "${value}": use exact or subsequence`)
  return value
}

export async function cmdBehavior(args: string[], log: (s: string) => void): Promise<number> {
  const flags = parseFlags(args, [
    '--config', '--golden', '--variants', '--policy', '--runs', '--mode', '--model', '--base-url',
    '--markdown', '--json', '--out-dir', '--fingerprint', '--if-changed', '--strict',
  ])
  const configPath = need(flags, '--config', 'behavior')
  const config = await loadConfig(configPath)
  applyOverrides(config, flags)
  const goldenPath = need(flags, '--golden', 'behavior')
  const golden = await loadTraceFile(goldenPath)
  const mode = parseMode(str(flags, '--mode'))

  const runsText = str(flags, '--runs') ?? '5'
  const runs = /^[0-9]+$/.test(runsText) ? Number(runsText) : NaN
  if (!Number.isInteger(runs) || runs < 1 || runs > 100) throw new UsageError(`--runs must be an integer from 1 to 100, got "${runsText}"`)

  const policyPath = str(flags, '--policy')
  const policy = policyPath ? await loadPolicyFile(policyPath) : undefined
  const variantsPath = str(flags, '--variants')
  const variantsFound = variantsPath !== undefined && (await exists(variantsPath))
  const variants = variantsFound ? (await loadVariantFile(variantsPath)).variants : []
  if (variantsPath !== undefined && !variantsFound) {
    log(`note: ${variantsPath} does not exist yet, so no alternative paths are approved. "agent-vcr accept" creates it.`)
  }
  if (mode === 'subsequence' && golden.calls.length === 0) {
    throw new UsageError('behavior: an empty golden trace cannot be used with --mode subsequence, because every run would match it')
  }

  // Decide whether live runs are needed at all.
  let changed: string[] | undefined
  const fingerprintPath = str(flags, '--fingerprint')
  if (flags.has('--if-changed') && !fingerprintPath) throw new UsageError('behavior: --if-changed needs --fingerprint <file>')
  if (fingerprintPath) {
    const current = configFingerprint(config, policy, { golden: golden.calls, variants, mode })
    if (await exists(fingerprintPath)) {
      changed = changedComponents(await loadFingerprintFile(fingerprintPath), current)
      if (flags.has('--if-changed') && changed.length === 0) {
        log(`skipped: behaviour inputs match ${fingerprintPath}, so no live runs were made`)
        return EXIT.ok
      }
    } else {
      log(`note: ${fingerprintPath} does not exist yet, so the check runs. Create it with "agent-vcr fingerprint --out".`)
    }
  }

  const model = config.model ?? 'gpt-4o-mini'
  log(`behavior: ${runs} live run${runs === 1 ? '' : 's'} of "${golden.scenario ?? config.scenario ?? 'scenario'}" on ${model}`)

  const report = await runBehaviorCheck({
    runs,
    baseline: { golden: golden.calls, variants, policy, mode },
    collect: async (): Promise<ToolCallRecord[]> => {
      let truncatedAt: number | undefined
      const trace = await recordTrace({ ...config, onTruncated: (max) => (truncatedAt = max) })
      // A run cut off mid-task did not finish. Classifying its partial trace
      // could match the golden trace by coincidence and read as a pass.
      if (truncatedAt !== undefined) {
        throw new Error(`run stopped at maxSteps (${truncatedAt}) while the model was still calling tools`)
      }
      return trace.calls
    },
    onRun: (r) => log(`  run ${r.runIndex}: ${r.class}${r.class === 'error' ? ` (${r.error})` : ''}`),
  })

  // Write each new path to disk so `accept` has a file to point at.
  const outDir = str(flags, '--out-dir')
  const written = new Map<string, string>()
  if (outDir && (report.newPaths.length > 0 || report.regressions.length > 0)) {
    await mkdir(outDir, { recursive: true })
    for (const path of [...report.newPaths, ...report.regressions]) {
      const file = join(outDir, `${path.id}.json`)
      await saveTraceFile(file, { version: 1, ...(golden.scenario ? { scenario: golden.scenario } : {}), calls: path.calls })
      written.set(path.id, file)
    }
  }

  log('')
  log(formatBehaviorConsole(report))

  const markdownPath = str(flags, '--markdown')
  if (markdownPath) {
    const target = variantsPath ?? 'traces/variants.json'
    const markdown = formatBehaviorMarkdown(report, {
      scenario: golden.scenario ?? config.scenario,
      changed,
      acceptCommand: (path) => {
        const trace = written.get(path.id)
        if (!trace) return ''
        return `npx agent-vcr accept --variants ${shellQuote(target)} --trace ${shellQuote(trace)} --name <name>${policyPath ? ` --policy ${shellQuote(policyPath)}` : ''}`
      },
    })
    await writeFile(markdownPath, `${markdown}\n`, 'utf8')
  }
  const jsonPath = str(flags, '--json')
  if (jsonPath) {
    await writeFile(jsonPath, `${JSON.stringify({ ...report, changed: changed ?? null }, null, 2)}\n`, 'utf8')
  }

  // A regression always fails. A check that could not finish fails too: it must
  // never read as a pass. Unreviewed paths fail only under --strict.
  if (report.verdict === 'regression' || report.verdict === 'inconclusive') return EXIT.changed
  if (report.verdict === 'review' && flags.has('--strict')) return EXIT.changed
  return EXIT.ok
}
