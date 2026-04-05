#!/usr/bin/env node
/**
 * @fileoverview Agent VCR CLI — validate, diff, record, and init.
 *
 * agent-vcr validate <trace.json>
 * agent-vcr diff <expected.json> <actual.json> [--mode exact|subsequence]
 * agent-vcr record --config <record.config.json> --out <trace.json> [--model <model>] [--base-url <url>]
 * agent-vcr init [--dir <path>] [--skip-existing]
 */

import { readFile } from 'node:fs/promises'
import { parseTraceFileV1, safeParseTraceFileV1 } from './schema.js'
import { compareTraces } from './diff.js'
import { callsEqual } from './normalize.js'
import { recordTrace } from './record.js'
import { initProject } from './init.js'
import { saveTraceFile } from './trace-io.js'
import type { CompareMode, ToolCallRecord } from './types.js'
import type { RecordConfig } from './record.js'

// ── ANSI color helpers (respects NO_COLOR and non-TTY) ───────────────────────
const isColor = process.env['NO_COLOR'] === undefined && process.stderr.isTTY

const c = {
  green: (s: string) => (isColor ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (isColor ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (isColor ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (isColor ? `\x1b[36m${s}\x1b[0m` : s),
  magenta: (s: string) => (isColor ? `\x1b[35m${s}\x1b[0m` : s),
  bold: (s: string) => (isColor ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (isColor ? `\x1b[2m${s}\x1b[0m` : s),
  gray: (s: string) => (isColor ? `\x1b[90m${s}\x1b[0m` : s),
}

// ── Usage ─────────────────────────────────────────────────────────────────────

function usage(): string {
  return `
${c.bold('Agent VCR')} — snapshot tests for LLM tool calls

${c.bold('Usage:')}
  ${c.cyan('agent-vcr validate')} ${c.yellow('<trace.json>')}
  ${c.cyan('agent-vcr diff')}     ${c.yellow('<expected.json> <actual.json>')} [--mode exact|subsequence]
  ${c.cyan('agent-vcr record')}   --config ${c.yellow('<record.config.json>')} --out ${c.yellow('<trace.json>')} [--model <model>] [--base-url <url>]
  ${c.cyan('agent-vcr init')}     [--dir <path>] [--skip-existing]

${c.bold('Commands:')}
  ${c.cyan('validate')}   Check a trace JSON matches schema v1
  ${c.cyan('diff')}       Compare expected vs actual traces; exits 1 on mismatch
  ${c.cyan('record')}     Call a real LLM, capture tool calls, save as golden trace
  ${c.cyan('init')}       Scaffold Agent VCR in a new project (traces/ + sample test)

${c.bold('Diff options:')}
  --mode exact         Same length + each call matches (default)
  --mode subsequence   Expected calls appear in order; extra actual calls allowed

${c.bold('Record options:')}
  --config <path>      JSON config (system, user, tools, stubs, scenario, ...)
  --out <path>         Where to write the golden trace
  --model <name>       Override model from config (default: gpt-4o-mini)
  --base-url <url>     Override base URL (default: https://api.openai.com/v1)
  OPENAI_API_KEY       Set your API key (or use config.apiKey)

${c.bold('Exit codes:')}
  0   Success
  1   Trace mismatch (diff)
  2   Usage error, invalid JSON, or schema error

${c.bold('Examples:')}
  agent-vcr validate traces/refund.expected.json
  agent-vcr diff traces/refund.expected.json traces/refund.actual.json
  agent-vcr diff traces/refund.expected.json traces/refund.actual.json --mode subsequence
  export OPENAI_API_KEY=… && agent-vcr record --config record.config.json --out traces/refund.expected.json
  agent-vcr init
`
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function loadJsonPath(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8')
  try {
    return JSON.parse(raw) as unknown
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`Invalid JSON in ${path}: ${msg}`)
  }
}

async function cmdValidate(path: string): Promise<void> {
  const data = await loadJsonPath(path)
  const parsed = parseTraceFileV1(data)
  const n = parsed.calls.length
  log(
    `${c.green('✔')} ${c.bold('Valid')} ${c.dim('—')} ${c.yellow(path)} ${c.dim(`(${n} call${n !== 1 ? 's' : ''}, schema v1)`)}`,
  )
}

async function cmdDiff(
  expectedPath: string,
  actualPath: string,
  mode: CompareMode,
): Promise<void> {
  const expRaw = await loadJsonPath(expectedPath)
  const actRaw = await loadJsonPath(actualPath)

  const expParsed = safeParseTraceFileV1(expRaw)
  const actParsed = safeParseTraceFileV1(actRaw)

  if (!expParsed.success) {
    log(`${c.red('✖')} Invalid expected trace: ${expectedPath}`)
    log(JSON.stringify(expParsed.error.flatten(), null, 2))
    process.exitCode = 2
    return
  }
  if (!actParsed.success) {
    log(`${c.red('✖')} Invalid actual trace: ${actualPath}`)
    log(JSON.stringify(actParsed.error.flatten(), null, 2))
    process.exitCode = 2
    return
  }

  const result = compareTraces(expParsed.data.calls, actParsed.data.calls, { mode })

  if (result.ok) {
    const n = expParsed.data.calls.length
    log(
      `${c.green('✔')} ${c.bold('Traces match')} ${c.dim(`(${mode}, ${n} call${n !== 1 ? 's' : ''})`)}\n` +
        expParsed.data.calls
          .map((call, i) => `  ${c.dim(`${i + 1}.`)} ${c.green(call.name)} ${c.gray(formatArgs(call))}`)
          .join('\n'),
    )
    return
  }

  // ── Mismatch — show a visual diff ──────────────────────────────────────────
  log(`\n${c.red('✖')} ${c.bold('Trace mismatch')} ${c.dim(`(${mode})`)}`)
  log(c.dim('─'.repeat(60)))
  log(`  ${c.red('reason:')} ${result.reason}`)

  if (result.index !== undefined) {
    log(`  ${c.red('at index:')} ${result.index}`)
  }
  if (result.expected) {
    log(`  ${c.dim('expected:')} ${c.green(formatCall(result.expected))}`)
  }
  if (result.actual) {
    log(`  ${c.dim('actual:  ')} ${c.red(formatCall(result.actual))}`)
  }

  // Show full side-by-side summary
  const exp = expParsed.data.calls
  const act = actParsed.data.calls
  const maxLen = Math.max(exp.length, act.length)

  if (maxLen > 0) {
    if (mode === 'subsequence') {
      log(
        `\n${c.bold('Trace lists')} ${c.dim('(subsequence mode: expected calls must appear in order inside actual; row alignment below would be misleading)')}`,
      )
      log(`  ${c.dim('expected →')} ${exp.map((x) => x.name).join(' → ')}`)
      log(`  ${c.dim('actual   →')} ${act.map((x) => x.name).join(' → ')}`)
    } else {
      log(`\n${c.bold('Full trace comparison')} ${c.dim('(exact mode, index-aligned)')}`)
      log(
        `  ${'#'.padEnd(3)} ${'Expected'.padEnd(30)} ${'Actual'.padEnd(30)} ${'Match'}`,
      )
      log(c.dim('  ' + '─'.repeat(72)))
      for (let i = 0; i < maxLen; i++) {
        const e = exp[i]
        const a = act[i]
        const eStr = e ? `${e.name}(${Object.keys(e.args).join(', ')})` : c.dim('(none)')
        const aStr = a ? `${a.name}(${Object.keys(a.args).join(', ')})` : c.dim('(none)')
        const match = e && a ? callsEqual(e, a) : false
        const indicator = match ? c.green('✔') : c.red('✖')
        log(
          `  ${String(i).padEnd(3)} ${(match ? c.green(eStr) : c.red(eStr)).padEnd(40)} ${(match ? c.green(aStr) : c.red(aStr)).padEnd(40)} ${indicator}`,
        )
      }
    }
  }

  log('')
  process.exitCode = 1
}

async function cmdRecord(args: string[]): Promise<void> {
  let configPath: string | undefined
  let outPath: string | undefined
  let modelOverride: string | undefined
  let baseURLOverride: string | undefined

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--config' || args[i] === '-c') && args[i + 1]) {
      configPath = args[++i]
    } else if ((args[i] === '--out' || args[i] === '-o') && args[i + 1]) {
      outPath = args[++i]
    } else if (args[i] === '--model' && args[i + 1]) {
      modelOverride = args[++i]
    } else if (args[i] === '--base-url' && args[i + 1]) {
      baseURLOverride = args[++i]
    }
  }

  if (!configPath || !outPath) {
    log(`${c.red('✖')} record: --config and --out are required`)
    log(`  Example: agent-vcr record --config record.config.json --out traces/my-flow.expected.json`)
    process.exitCode = 2
    return
  }

  // Load record config
  const rawConfig = await loadJsonPath(configPath)
  const config = rawConfig as RecordConfig

  if (modelOverride) config.model = modelOverride
  if (baseURLOverride) config.baseURL = baseURLOverride

  const model = config.model ?? 'gpt-4o-mini'
  const scenario = config.scenario ?? 'recorded'

  log(`${c.cyan('*')}  ${c.bold('Recording')} ${c.dim('—')} scenario: ${c.yellow(scenario)}, model: ${c.magenta(model)}`)
  log(`   ${c.dim(`user: "${truncate(config.user, 60)}"`)}\n`)

  let step = 0

  const trace = await recordTrace({
    ...config,
    onToolCall: (record: ToolCallRecord, s: number) => {
      step = s
      log(`   ${c.green(`${s}.`)} ${c.bold(record.name)} ${c.gray(formatArgs(record))}`)
    },
  })

  if (step === 0) {
    log(`   ${c.yellow('⚠')}  No tool calls recorded — the model returned text only.`)
    log(`      Check your system prompt and tool definitions.\n`)
  }

  await saveTraceFile(outPath, trace)
  log(`\n${c.green('✔')} ${c.bold('Saved')} ${c.dim('→')} ${c.yellow(outPath)} ${c.dim(`(${trace.calls.length} call${trace.calls.length !== 1 ? 's' : ''})`)}\n`)
  log(
    c.dim(
      `  Commit this file to git. Run your tests with ScriptedLlm to replay it deterministically.`,
    ),
  )
}

async function cmdInit(args: string[]): Promise<void> {
  let dir: string | undefined
  let skipExisting = false

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--dir' || args[i] === '-d') && args[i + 1]) {
      dir = args[++i]
    } else if (args[i] === '--skip-existing') {
      skipExisting = true
    }
  }

  log(`${c.cyan('⚡')} ${c.bold('Initializing Agent VCR')} ${c.dim(dir ? `in ${dir}` : 'in current directory')}\n`)

  const result = await initProject({ dir, skipExisting })

  for (const f of result.created) {
    log(`  ${c.green('+')} ${f}`)
  }
  for (const f of result.skipped) {
    log(`  ${c.yellow('~')} ${f} ${c.dim('(skipped — already exists)')}`)
  }

  log(`\n${c.green('✔')} ${c.bold('Done!')} Next steps:`)
    log(`  ${c.dim('1.')} ${c.cyan('npm install agent-vcr')}`)
  log(`  ${c.dim('2.')} Edit ${c.yellow('traces/example.expected.json')} or run ${c.cyan('agent-vcr record --config record.config.json --out traces/example.expected.json')}`)
  log(`  ${c.dim('3.')} ${c.cyan('npx vitest run')} — your first VCR test passes out of the box\n`)
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2)

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(usage())
    return
  }

  const cmd = args[0]!

  try {
    if (cmd === 'validate') {
      const p = args[1]
      if (!p) { log(`${c.red('✖')} validate: missing <trace.json>`); process.exitCode = 2; return }
      await cmdValidate(p)
      return
    }

    if (cmd === 'diff') {
      let mode: CompareMode = 'exact'
      const rest: string[] = []
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--mode' && args[i + 1]) {
          const m = args[++i]!
          if (m !== 'exact' && m !== 'subsequence') {
            log(`${c.red('✖')} diff: unknown mode "${m}" — use exact or subsequence`)
            process.exitCode = 2
            return
          }
          mode = m
        } else {
          rest.push(args[i]!)
        }
      }
      if (rest.length < 2) {
        log(`${c.red('✖')} diff: expected <expected.json> <actual.json>`)
        process.exitCode = 2
        return
      }
      await cmdDiff(rest[0]!, rest[1]!, mode)
      return
    }

    if (cmd === 'record') {
      await cmdRecord(args.slice(1))
      return
    }

    if (cmd === 'init') {
      await cmdInit(args.slice(1))
      return
    }

    log(`${c.red('✖')} Unknown command: ${c.bold(cmd)}\n`)
    process.stdout.write(usage())
    process.exitCode = 2
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log(`${c.red('✖')} ${msg}`)
    process.exitCode = 2
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(msg + '\n')
}

function formatArgs(call: ToolCallRecord): string {
  const keys = Object.keys(call.args)
  if (keys.length === 0) return '{}'
  const pairs = keys.slice(0, 3).map((k) => `${k}: ${JSON.stringify(call.args[k])}`)
  const suffix = keys.length > 3 ? `, +${keys.length - 3} more` : ''
  return `{ ${pairs.join(', ')}${suffix} }`
}

function formatCall(call: ToolCallRecord): string {
  return `${call.name}(${formatArgs(call)})`
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

main(process.argv).catch((e) => {
  process.stderr.write(`${c.red('✖')} ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 2
})
