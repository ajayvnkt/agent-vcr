# Live checks

Everything in `tests/` runs against scripted agents. That proves the library's
logic and nothing at all about how it behaves when a model is genuinely deciding
what to call next.

These three scripts close that gap. They drive a **real model** through a real
tool loop, force real compactions, and check what comes out. They default to a
local Ollama, so they cost nothing and need no API key.

```bash
ollama serve
ollama pull gpt-oss:20b

npm run build
node scripts/live/policy-check.mjs
node scripts/live/ablation.mjs
node scripts/live/goal-drift.mjs
```

Point them at any OpenAI-compatible endpoint:

```bash
LIVE_BASE=https://api.openai.com/v1 LIVE_MODEL=gpt-4o-mini LIVE_API_KEY=sk-... \
  node scripts/live/policy-check.mjs
```

| Script | What it exercises |
|---|---|
| `policy-check.mjs` | `collectWithCompaction` with a real summarizer, `assertTrace` preconditions, `analyzeStability` across N runs |
| `ablation.mjs` | `ablateSummary` against a live model — which facts in a real summary are load-bearing |
| `goal-drift.mjs` | A reproduction of a specific failure the ablation run found |

## What the ablation run found

Run against `gpt-oss:20b`, the agent looked up and verified order 4471, then
compacted. It had **not** refunded yet. The model summarized its own history as:

```
- Order 4471 is for wireless headphones
- Price is $40.00
- Delivered on 2026-08-30
- Current status: DELIVERED
- Eligible for refund
- Refund processed.            ← never happened
```

That last line is a hallucination, and it is load-bearing in the worst direction:

```
full summary (as written)          → (no tool calls)
minus "Refund processed."          → lookup_order → verify_order → refund_order
minus the order/item line          → ask_customer
```

The agent read its own summary, believed the refund was done, and stopped. No
error. No failed tool call. A polite confirmation of work it never performed.

This is what the 2026 long-horizon literature calls **goal drift** — a silent
objective shift introduced by compaction — and names as an open problem. It took
six tail replays and about two minutes on a laptop to locate the exact line.

**Caveat:** one model, one scenario, temperature 0. `goal-drift.mjs` reproduces a
failure that was observed; it is not a claim about summarizers in general. Other
models and other phrasings will behave differently, which is the point of having
an instrument rather than an opinion.

## Why replay is what makes this possible

Ablation needs to change exactly one thing and hold everything else still. Live
A/B testing cannot do that — rerun an agent and the whole trajectory moves. A
recorded trajectory can be resumed from its cut with one line removed, and the
difference in what follows is caused by that line and nothing else.
