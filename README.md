# Agent VCR

<p align="center">
  <strong>Snapshot tests for LLM tool calls.<br>Record once. Catch regressions forever. Zero live-LLM cost in CI once golden traces are committed.</strong>
</p>

<p align="center">
  <a href="https://github.com/ajayvnkt/agent-vcr/actions/workflows/ci.yml"><img src="https://github.com/ajayvnkt/agent-vcr/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/agent-vcr"><img src="https://img.shields.io/npm/v/agent-vcr?label=npm&color=cb3837" alt="npm"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://www.npmjs.com/package/agent-vcr"><img src="https://img.shields.io/npm/dm/agent-vcr?color=blue" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18-green" alt="Node.js">
</p>

<p align="center">
  <a href="#the-problem">Problem</a> &bull;
  <a href="#install">Install</a> &bull;
  <a href="#quick-start-3-minutes">Quick Start</a> &bull;
  <a href="#record-mode">Record</a> &bull;
  <a href="#examples">Examples</a> &bull;
  <a href="#framework-adapters">Adapters</a> &bull;
  <a href="#cli">CLI</a> &bull;
  <a href="#library-api">API</a> &bull;
  <a href="#github-actions">CI</a>
</p>

---

## The Problem

You shipped a support agent. It worked perfectly in testing.

Three weeks later, someone tweaks a prompt — and now it's issuing refunds **without verifying the order first**. The LLM still *sounds* right. But the tool call sequence broke.

**No test caught it. No eval flagged it. Only a production incident revealed it.**

Agent VCR fixes this. It's **VCR for your tool calls** — the same idea as HTTP cassette recording, applied to `tool_calls`. Record the exact sequence your agent should call, check it into git, and let CI fail the build if anything drifts.

```
Without Agent VCR:     prompt change → "it still works" → production incident
With Agent VCR:        prompt change → CI fails → you fix it before merging
```

---

## Why Agent VCR?

| | Without Agent VCR | With Agent VCR |
|---|---|---|
| **CI signal** | Manual click-through or flaky live LLM | ✅ Deterministic — same trace every run |
| **CI cost** | API keys + $$$ per PR | ✅ Zero live-model cost in CI once golden traces exist (recording still calls your API) |
| **Regression detection** | Hope for the best | ✅ Build fails if tool sequence changes |
| **Tool order** | Untested | ✅ Guaranteed by golden trace |
| **Arg validation** | Ad-hoc | ✅ Schema v1 + `validate` CLI in CI |
| **Framework** | Re-invent test harness | ✅ Drop-in adapters for OpenAI, Anthropic, Vercel AI, LangChain |

> **What it tests:** Tool dispatch logic, routing graphs, arg shapes, guard rails.
> **What it doesn't test:** Model quality or reasoning — keep those in evals and staging.

---

## Install

Install the package via your preferred package manager:

```bash
npm install agent-vcr
# or
pnpm add agent-vcr
# or
yarn add agent-vcr
```

Then, you can access the library in your code (supports both ESM and CommonJS):

```typescript
// ESM / TypeScript
import { ScriptedLlm, collectToolCalls } from 'agent-vcr'

// CommonJS
const { ScriptedLlm, collectToolCalls } = require('agent-vcr')
```

**Scaffold a new project in one command:**

```bash
npx agent-vcr init
```

Creates `traces/example.expected.json`, a sample Vitest test, and a `record.config.json` — ready to run.

### API keys and environment variables

Live recording and SDK adapters need provider credentials in your environment (or in `record.config.json` as `apiKey` for OpenAI-compatible recording only). **Never commit real keys** — copy [`.env.example`](.env.example) to `.env` locally and fill in values, or use `export` / your CI secret store.

| What you use | Typical env var | Where to get a key |
|--------------|-----------------|-------------------|
| `agent-vcr record`, `recordTrace`, OpenAI SDK adapter | `OPENAI_API_KEY` | [OpenAI API keys](https://platform.openai.com/api-keys) |
| Anthropic SDK adapter (`fromAnthropic`) | `ANTHROPIC_API_KEY` | [Anthropic console](https://console.anthropic.com/settings/keys) |
| Vercel AI + `@ai-sdk/openai` | `OPENAI_API_KEY` | Same as OpenAI |
| LangChain `ChatOpenAI` | `OPENAI_API_KEY` | Same as OpenAI |
| OpenAI-compatible base URL (Groq, Ollama, Azure proxy, …) | `OPENAI_API_KEY` or `apiKey` in config | Provider docs; Ollama often needs no real secret |

For non-OpenAI Vercel AI providers (for example `@ai-sdk/google`), use the env variable names from [Vercel AI provider docs](https://sdk.vercel.ai/providers) — Agent VCR does not read those directly; your SDK does.

```bash
# Node 20+: load .env for the CLI process (from a project with agent-vcr installed)
node --env-file=.env ./node_modules/.bin/agent-vcr record --config record.config.json --out traces/out.json
```

---

## Quick Start (3 minutes)

### Step 1 — Record your agent with a real LLM (once)

Create `record.config.json`:

```json
{
  "system": "You are a support agent. Always look up the order before refunding.",
  "user": "Refund $10 on order 123",
  "scenario": "refund_happy_path",
  "model": "gpt-4o-mini",
  "tools": [
    {
      "name": "lookup_order",
      "description": "Look up an order by ID",
      "parameters": {
        "type": "object",
        "properties": { "orderId": { "type": "string" } },
        "required": ["orderId"]
      }
    },
    {
      "name": "refund_order",
      "description": "Refund an order",
      "parameters": {
        "type": "object",
        "properties": {
          "orderId": { "type": "string" },
          "amount": { "type": "number" }
        },
        "required": ["orderId", "amount"]
      }
    }
  ],
  "stubs": {
    "lookup_order": { "found": true, "orderId": "123", "balanceCents": 1000 },
    "refund_order": { "ok": true }
  }
}
```

```bash
export OPENAI_API_KEY="…"   # never commit keys; or run with Node 20+: node --env-file=.env …
npx agent-vcr record --config record.config.json --out traces/refund.expected.json
```

```
*  Recording — scenario: refund_happy_path, model: gpt-4o-mini
   user: "Refund $10 on order 123"

   1. lookup_order { orderId: "123" }
   2. refund_order { orderId: "123", amount: 10 }

✔ Saved → traces/refund.expected.json (2 calls)

  Commit this file to git. Run your tests with ScriptedLlm to replay deterministically.
```

That JSON file is now your **golden trace**. Commit it.

---

### Step 2 — Replay deterministically in CI (no API key needed)

```ts
// tests/refund-agent.vcr.test.ts
import { describe, it, expect } from 'vitest'
import {
  ScriptedLlm,
  assistantText,
  assistantWithTools,
  collectToolCalls,
  compareTraces,
  loadTraceFile,
  toolCall,
} from 'agent-vcr'

describe('refund agent — tool trace', () => {
  it('always looks up before refunding (happy path)', async () => {
    const llm = new ScriptedLlm([
      assistantWithTools([toolCall('lookup_order', { orderId: '123' }, 'c1')]),
      assistantWithTools([toolCall('refund_order', { orderId: '123', amount: 10 }, 'c2')]),
      assistantText('Done.'),
    ])

    const recorded = await collectToolCalls({
      system: 'You are a support agent.',
      user: 'Refund $10 on order 123',
      llm,
      async executeTool(name) {
        if (name === 'lookup_order') return { found: true }
        if (name === 'refund_order') return { ok: true }
        throw new Error(`Unknown tool: ${name}`)
      },
    })

    const expected = await loadTraceFile('traces/refund.expected.json')
    const result = compareTraces(expected.calls, recorded)
    expect(result).toEqual({ ok: true })
  })

  it('catches regression when lookup is skipped', async () => {
    const badLlm = new ScriptedLlm([
      // Simulates a prompt change that causes the model to skip lookup
      assistantWithTools([toolCall('refund_order', { orderId: '123', amount: 10 }, 'c1')]),
      assistantText('Done.'),
    ])

    const recorded = await collectToolCalls({
      system: 'You are a support agent.',
      user: 'Refund $10 on order 123',
      llm: badLlm,
      async executeTool(name) {
        if (name === 'refund_order') return { ok: true }
        throw new Error(`Unknown tool: ${name}`)
      },
    })

    const expected = await loadTraceFile('traces/refund.expected.json')
    expect(compareTraces(expected.calls, recorded).ok).toBe(false) // ← build fails!
  })
})
```

```bash
npx vitest run   # ✔ passes in CI — no API key, no cost, same result every time
```

---

## Record Mode

`agent-vcr record` reads **`record.config.json`** (prompts, tool schemas, stubs), calls a **real LLM** over the OpenAI-compatible HTTP API, and writes the resulting tool calls to a golden trace. It does **not** import or run your app’s own agent entrypoint — for that, use **`collectToolCalls`** in tests with your SDK adapter and `executeTool` implementation.

```bash
# Basic usage (OPENAI_API_KEY in env — export, shell profile, or node --env-file=.env)
agent-vcr record --config record.config.json --out traces/my-flow.expected.json

# Override model
agent-vcr record --config record.config.json --out traces/my-flow.expected.json --model gpt-4o

# Point at any OpenAI-compatible API (Anthropic proxy, Groq, Ollama, Azure, ...)
agent-vcr record --config record.config.json --out traces/my-flow.expected.json \
  --base-url https://api.groq.com/openai/v1 \
  --model llama-3.3-70b-versatile
```

**Record config fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `system` | string | No | System prompt |
| `user` | string | **Yes** | User message |
| `tools` | ToolDefinition[] | **Yes** | Tools with JSON Schema parameters |
| `stubs` | `Record<name, result>` | No | Tool responses during recording (default: `{ ok: true }`) |
| `scenario` | string | No | Label written to the trace file |
| `model` | string | No | Model name (default: `gpt-4o-mini`) |
| `baseURL` | string | No | API base URL (default: OpenAI) |
| `apiKey` | string | No | Falls back to `OPENAI_API_KEY` env var |
| `maxSteps` | number | No | Max tool-calling rounds (default: 16) |
| `httpFetch` | `typeof fetch` | No | API only — passed to `recordTrace()` to override global `fetch` (tests, proxies). Not supported in `record.config.json`. |

---

## Examples

All examples run with `npm run build` first (uses `dist/`):

```bash
npm run build && npm run example:all
```

| Example | Scenario | Key concept |
|---|---|---|
| [minimal](examples/minimal/) | Refund agent | Basic record → replay |
| [email-router](examples/email-router/) | Route emails by category + priority | Multi-step routing |
| [financial-transfer](examples/financial-transfer/) | Balance → limit → transfer | High-stakes sequencing + regression demo |
| [rag-validation](examples/rag-validation/) | Search → rerank → cite | `subsequence` mode for flexible pipelines |
| [ticket-escalation](examples/ticket-escalation/) | VIP customer 4-step escalation | Long tool chains |
| [compaction-stability](examples/compaction-stability/) | Support agent that outgrows its context | Run-to-run variance + summary ablation |
| [reliability-suite](examples/reliability-suite/) | Four agents, four failure shapes | Policy assertions, variants, multi-turn, gated judge |

**Run individually:**

```bash
npm run example:email-router
npm run example:financial-transfer   # includes intentional regression demo
npm run example:rag-validation
npm run example:ticket-escalation
npm run example:compaction-stability # no API key needed
npm run example:reliability-suite    # no API key needed
```

---

## Reliability Suite

A golden trace answers one question — *is this byte-identical to last time?* — and answers it too strictly. Agents legitimately reorder independent calls, retry, or hit a cache. Pin the whole sequence and every harmless variation fails the build; loosen the comparison until it stops complaining and it stops catching regressions too.

What teams actually want to enforce is narrower and stronger. Four things, in ascending cost.

### Tier 1 — policy, not sequences

```typescript
import { assertTrace } from 'agent-vcr'

const failures = assertTrace(calls, {
  // Never refund without verifying first. This is the rule, not a trace.
  requires: [['refund_order', 'verify_order']],
  forbid: ['delete_account'],
  sequence: ['lookup_order', 'refund_order'],   // order, gaps allowed
  includes: [{ name: 'refund_order', args: { amount: { oneOf: [10, 40] } } }],
  maxCallsPerTool: 2,                            // catches retry storms
})
```

`requires` and `ordering` look similar and are not. `ordering: [['verify', 'refund']]` says nothing at all when `verify` is absent — so an agent that refunds *without ever verifying* passes. `requires: [['refund', 'verify']]` fails it. The second one is the actual policy.

Every failure is returned, not just the first: one CI run should tell you everything that's wrong, not make you fix and re-push six times.

### Tier 2 — more than one correct path

```typescript
import { matchVariants, proposeVariants } from 'agent-vcr'

const match = matchVariants(calls, [
  { name: 'cache-hit',  calls: [lookup, reply] },
  { name: 'cache-miss', calls: [lookup, fetch, reply] },
])
// → no accepted path matched (tried "cache-hit", "cache-miss").
//   Closest was "cache-miss", which diverged at call 2: call 2 differs
```

Each path stays exact; the set simply accepts more than one. `proposeVariants(runs)` ranks the shapes you actually observed so you can approve them deliberately — approval is always an explicit call, because a suite that widens its own definition of correct whenever it fails is not testing anything.

### Tier 3 — multi-turn scenarios

Most orchestration bugs live in conversations, not single prompts: the agent that acts before it clarifies, or re-asks for something it already has.

```typescript
import { runSuite, formatMarkdown, keywordJudge } from 'agent-vcr'

const scenarios = [{
  name: 'refund/clarify-first',
  agent: () => myAgent(),               // you bring the framework
  turns: [
    { user: 'I want a refund',  expect: { forbid: ['refund_order'] } },
    { user: 'Order 123 please', expect: { includes: ['refund_order'] } },
  ],
  expectOverall: { requires: [['refund_order', 'verify_order']] },
}]

const result = await runSuite(scenarios, {
  runs: 6,
  gate: { minPassRate: 1, requireStable: true },
})
```

The agent is injected. agent-vcr doesn't want to own your framework — you bring something that answers a user message, it brings the discipline.

### Tier 4 — the judge, gated

The four tiers differ in cost by three orders of magnitude: structural (free), assertions (free), text checks (free), LLM judge (~$0.01/test). So the judge is **only asked about runs that already passed everything free**. A run that called `refund_order` before `verify_order` is broken; paying a model to grade its prose tells you nothing and bills you on every commit.

With no judge configured the suite is fully deterministic and free — that's what runs on every push. `keywordJudge()` grades `expect:` clauses with no model at all, so a suite written against the judge interface still runs on a plane.

### The gate that catches what a pass rate can't

```
✗ refund/policy  0/1 runs
    turn 1: "refund_order" at index 1 requires a prior "verify_order", which was never called
✓ lookup/either-path  6/6 runs  [stable, modal 100%]
✗ policy-qa/reliability  6/6 runs  [bimodal, modal 67%]
    gate: behaviour is bimodal across 6 runs (3 distinct traces)
```

Read the last line again: **6 out of 6 runs passed, and the gate failed it.** Every run reached the right answer by a different route. A pass rate reports that identically to a genuinely reliable agent, and it is one prompt tweak from an incident.

`requireStable` is the knob no other harness gives you. `formatMarkdown()` renders the whole thing as a PR comment with collapsible detail; `formatJson()` for dashboards.

---

## Long-Horizon Mode: Compaction, Stability, Ablation

An agent that runs long enough will summarize its own history and continue. That
summary is not preprocessing — it is **an action taken by the policy**, and it is
the only action whose effect is to rewrite the agent's own observations. Nearly
every long-horizon failure that shows up as "it worked yesterday" starts there.

Agent VCR treats a compaction as a first-class trace event, which makes two things
measurable that a pass rate cannot show you.

### 1. Stability — the variance a mean hides

Compaction barely moves the average. It blows up the **variance**, and the shape is
bimodal: a run either holds together or derails. A 66% pass rate can mean "reliably
mediocre" or "excellent two runs in three, catastrophic on the third" — and only the
second one pages you at 2am.

```typescript
import { collectWithCompaction, compactAtTokenBudget, analyzeStability } from 'agent-vcr'

const runs = []
for (let i = 0; i < 12; i++) {
  runs.push(await collectWithCompaction({
    system: 'You are a support agent. Verify the order before refunding.',
    user: 'Refund the customer for their damaged item.',
    llm, executeTool,
    compaction: {
      shouldCompact: compactAtTokenBudget(60_000),
      summarize: async (messages) => summarizeWithModel(messages),
      keepRecentTurns: 2,
    },
  }))
}

const report = analyzeStability(runs, { attributionWindow: 3 })
console.log(report.verdict)   // 'stable' | 'drifting' | 'bimodal'
console.log(report.summary)
```

```
verdict                 bimodal
distinct traces         3
modal share             42%
attributable to a cut   100% of diverging runs
first-divergence calls  {"3":7}
```

Runs are compared to their **mode**, not to a golden trace, because this measures
self-consistency — a separate question from correctness. An agent can be perfectly
consistent and consistently wrong.

### 2. Ablation — which facts the summary must keep

The open question in long-horizon agents is what a summary has to preserve, and it
cannot be answered by reading the summary: faithful and useful are different
properties, and usefulness is only visible in what the agent does afterwards.

Because replay is deterministic, you can answer it causally. Hold the trajectory
fixed, remove one fact from the summary, resume from the cut, and diff the calls
that follow. Whatever changes behaviour is load-bearing; the rest is prose.

```typescript
import { ablateSummary } from 'agent-vcr'

const cut = baselineRun.compactions[0]

const ablation = await ablateSummary({
  baseline: baselineRun.calls.slice(cut.atCall),
  summary: cut.summary,
  replay: (mutatedSummary) => replayTailWith(mutatedSummary),
})

console.log(ablation.compactionSchema)
```

```
droppable     customer u-22 opened ticket T-9 asking for a refund
LOAD-BEARING  the order in question is 4471
droppable     refund policy allows refunds within 30 days
droppable     customer has 3 prior orders, no prior refunds
droppable     customer was polite throughout

1 of 5 facts are load-bearing (20% signal).
```

Cost is `facts × repeats` replays **of the tail only** — everything before the cut
comes from the recording.

The output is a contract. Commit `compactionSchema` next to the golden trace and CI
fails when a prompt change, a model swap, or a tighter token budget produces a summary
that drops one of those facts — before the trajectory derails in production.

> **Note on scope:** ablation finds the facts that matter *for this scenario*, which
> is a hand-writable compaction schema, not a general policy. Training a compactor
> with RL generalizes across tasks; this does not. It costs a handful of replays
> instead of thousands of runs and a GPU, and for most production agents that trade
> is the right one.

---

## Framework Adapters

Agent VCR works with your existing LLM SDK. Import the adapter for your framework — no peer dependency added to Agent VCR itself.

### OpenAI SDK

```ts
import OpenAI from 'openai'
import { collectToolCalls, compareTraces, loadTraceFile } from 'agent-vcr'
import { fromOpenAI } from 'agent-vcr/adapters/openai'

const client = new OpenAI()
const llm = fromOpenAI(client, 'gpt-4o-mini', {
  tools: [/* your OpenAI tool definitions */],
})

const recorded = await collectToolCalls({
  user: 'Refund order 123',
  llm,
  executeTool: async (name, args) => myDispatch(name, args),
})
```

### Anthropic SDK

```ts
import Anthropic from '@anthropic-ai/sdk'
import { collectToolCalls } from 'agent-vcr'
import { fromAnthropic } from 'agent-vcr/adapters/anthropic'

const client = new Anthropic()
const llm = fromAnthropic(client, 'claude-3-5-sonnet-20241022', {
  tools: [
    {
      name: 'lookup_order',
      description: 'Look up an order by ID',
      input_schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
    },
  ],
})
```

### Vercel AI SDK

```ts
import { openai } from '@ai-sdk/openai'
import { collectToolCalls } from 'agent-vcr'
import { fromVercelAI } from 'agent-vcr/adapters/vercel-ai'
import { z } from 'zod'

const llm = fromVercelAI(openai('gpt-4o-mini'), {
  tools: {
    lookup_order: {
      description: 'Look up an order by ID',
      parameters: z.object({ orderId: z.string() }),
    },
  },
})
```

### LangChain.js

```ts
import { ChatOpenAI } from '@langchain/openai'
import { collectToolCalls } from 'agent-vcr'
import { fromLangChain } from 'agent-vcr/adapters/langchain'

const chat = new ChatOpenAI({ model: 'gpt-4o-mini' })
const llm = fromLangChain(chat.bindTools([lookupOrderTool, refundOrderTool]))
```

### Any OpenAI-compatible API

```bash
# Groq
agent-vcr record --config cfg.json --base-url https://api.groq.com/openai/v1 --model llama-3.3-70b-versatile

# Ollama (local)
agent-vcr record --config cfg.json --base-url http://localhost:11434/v1 --model llama3.2
```

---

## How It Works

```
  ┌─────────────────────────────────────────────────────────────────┐
  │  RECORD (once, with real LLM)          REPLAY (CI, no live LLM)  │
  │                                                                 │
  │  User ──► Real LLM ──► tool_calls      User ──► ScriptedLlm   │
  │              │                                      │           │
  │        Real APIs                            executeTool stubs  │
  │              │                                      │           │
  │         save to                          compare to            │
  │   traces/*.expected.json  ◄────────────  traces/*.expected.json│
  │         (git commit)                      fail build on drift  │
  └─────────────────────────────────────────────────────────────────┘
```

**What `ScriptedLlm` validates:** Given *these* model decisions (scripted), your code still dispatches the right tools with the right arguments.

**What it doesn't validate:** What the model *would actually decide* with a live API — that lives in evals, staging, and occasional integration runs.

**Two comparison modes:**

- **`exact`** — Same length, each call matches name + args. Strictest. Use for deterministic flows like financial operations.
- **`subsequence`** — Expected calls appear in order inside actual; extra calls allowed. Use for flexible pipelines like RAG where intermediate steps may change.

---

## Trace File Format

Golden traces are plain JSON — human-readable, diffable, language-agnostic:

```json
{
  "version": 1,
  "scenario": "refund_happy_path",
  "calls": [
    { "name": "lookup_order",  "args": { "orderId": "123" } },
    { "name": "refund_order",  "args": { "orderId": "123", "amount": 10 } }
  ]
}
```

Any language can emit this format and use the CLI to diff it. The schema is validated with Zod on both read and write.

---

## CLI

```bash
# Scaffold Agent VCR in a new project
agent-vcr init [--dir <path>] [--skip-existing]

# Record a golden trace with a real LLM
agent-vcr record --config <record.config.json> --out <trace.json> [--model <name>] [--base-url <url>]

# Validate a trace file matches schema v1
agent-vcr validate <trace.json>

# Diff expected vs actual (exits 1 on mismatch)
agent-vcr diff <expected.json> <actual.json> [--mode exact|subsequence]
```

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Trace mismatch (`diff`) |
| `2` | Usage error, invalid JSON, or schema error |

**Example diff output (mismatch):**

```
✖ Trace mismatch (exact)
────────────────────────────────────────────────────────────
  reason: call 0 differs
  at index: 0
  expected: lookup_order({ orderId: "123" })
  actual:   refund_order({ orderId: "123", amount: 10 })

Full trace comparison:
  #   Expected                        Actual                          Match
  ────────────────────────────────────────────────────────────────────────────
  0   lookup_order(orderId)           refund_order(orderId, amount)   ✖
  1   refund_order(orderId, amount)   (none)                          ✖
```

---

## Library API

| Export | Description |
|---|---|
| `collectToolCalls(options)` | Run assistant ↔ tool loop; returns `ToolCallRecord[]` |
| `ScriptedLlm(turns)` | Deterministic `complete()` — returns scripted turns in order |
| `toolCall(name, args, id?)` | Build a `ToolCallSpec` for scripted turns |
| `assistantWithTools(specs)` | Build an assistant turn that calls tools |
| `assistantText(content)` | Build a final text-only assistant turn |
| `compareTraces(expected, actual, options?)` | Compare two `ToolCallRecord[]` lists |
| `loadTraceFile(path)` | Read + validate a trace JSON file |
| `saveTraceFile(path, trace)` | Validate + write a trace JSON file |
| `recordTrace(config)` | Call a real LLM, capture tool calls, return trace (see `httpFetch` above). Never commit API keys — use `OPENAI_API_KEY` locally only |
| `initProject(options?)` | Scaffold traces/ dir + sample test |
| `parseTraceFileV1(raw)` | Parse raw JSON (throws on invalid) |
| `safeParseTraceFileV1(raw)` | Parse raw JSON (returns `{ success, error }`) |

---

## GitHub Actions

```yaml
# This repo’s workflow (see .github/workflows/ci.yml): Node 18/20/22 matrix,
# build before test, validate every examples/*/traces/*.expected.json, then example:all.

- uses: actions/checkout@v5
- uses: actions/setup-node@v5
  with:
    node-version: ${{ matrix.node-version }} # 18, 20, 22
    cache: npm
    cache-dependency-path: package-lock.json

- run: npm ci
- run: npm run lint
- run: npm run build
- run: npm test

- name: Validate golden traces
  run: |
    for f in examples/*/traces/*.expected.json; do
      node dist/cli.js validate "$f"
    done

- run: npm run example:all

# In your own app, point the glob at your traces (e.g. traces/*.expected.json)
# and use `npx agent-vcr validate` if you depend on the package instead of dist/.
```

---

## Roadmap

Current release: trace schema v1, `compareTraces` (`exact` / `subsequence`), `ScriptedLlm`, `collectToolCalls`, CLI (`validate`, `diff`, `record`, `init`), adapters (OpenAI, Anthropic, Vercel AI, LangChain), and five runnable examples under `examples/`.

Planned: arg redaction for secrets in traces; CLI flags `--forbidden-tools` / `--budget`; Python client; LangGraph adapter; HTML diff report.

---

## Use Cases

**When should I use Agent VCR?**

- ✅ Support agents that must verify before acting (lookup → refund, check → transfer)
- ✅ Email/ticket routing agents where wrong routing = real business impact
- ✅ RAG pipelines where "skipping retrieval" = silent hallucination
- ✅ Financial operations with mandatory compliance steps
- ✅ Any agent where tool *order* matters as much as the final answer

**When is it a poor fit?**

- ❌ Agents with no structured tools (pure text generation)
- ❌ Teams only caring about prose quality (use evals instead)
- ❌ Highly exploratory agents where tool sequence legitimately varies every run (use `subsequence` mode or evals)

---

## Further reading

**[Your agent didn’t break. Your tool trace did.](https://medium.com/@vnktajay/your-agent-didnt-break-your-tool-trace-did-9d0ec45e7629)** — background on why tool-call order belongs in CI.

---

## Contributing

Contributions welcome — open an issue or PR on [GitHub](https://github.com/ajayvnkt/agent-vcr).

```bash
git clone https://github.com/ajayvnkt/agent-vcr.git
cd agent-vcr
npm install
npm run build && npm test && npm run example:all
```

Please run `npm run lint && npm test` before submitting. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## License

MIT — see [LICENSE](LICENSE) for details.
