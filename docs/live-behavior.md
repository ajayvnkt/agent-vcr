# Live behaviour checks

Replay with `ScriptedLlm` is deterministic and free, which is why it belongs on
every pull request. It tests the orchestration around a model. By design it
cannot tell you whether a new prompt, model or tool schema would make the model
decide differently in the first place.

Live behaviour checks are the optional second layer. They run the agent against a
real model a few times and sort every run against what the suite already knows.

| | Replay (`ScriptedLlm`) | Live behaviour check |
|---|---|---|
| Asks a real model | No | Yes |
| Cost per run | None | Model calls |
| Deterministic | Yes | No |
| When to run | Every pull request | When a behaviour-deciding input changes |
| Answers | Did the wiring break? | Did the model's decisions move? |

## The five outcomes

Each live run lands in exactly one bucket.

| Outcome | Meaning |
|---|---|
| `golden` | Matches the golden trace |
| `accepted` | Matches an approved alternative path |
| `unreviewed` | A path nobody has seen before that breaks no stated policy |
| `regression` | Breaks a stated policy |
| `error` | The run did not finish, so it says nothing about behaviour |

The batch then reduces to one verdict, checked in this order:

| Verdict | When | CLI exit code |
|---|---|---|
| `regression` | Any run broke policy | 1 |
| `inconclusive` | No regression, but a run did not finish | 1 |
| `review` | No regression or error, but a run took an unapproved path | 0, or 1 with `--strict` |
| `unchanged` | Every run matched the golden trace or an approved path | 0 |

Three rules are worth knowing before you rely on this.

- **Policy is checked first and always wins.** A run that matches the golden
  trace but breaks policy is a regression. That happens when the policy was
  tightened after the trace was recorded; the report also lists it under
  "Baseline needs attention".
- **`unreviewed` does not mean harmless.** It means no written rule was broken.
  Whether the path is acceptable is a person's decision, made with `accept`.
- **Without a policy there are no regressions.** Every unknown path is
  `unreviewed`, and the report states that nothing was checked.
- **"Matches" depends on `--mode`.** In the default `exact` mode it means
  identical. In `subsequence` mode a run matches when it contains the known path
  in order, so extra calls pass unless a policy rule forbids them. Use
  `subsequence` only together with a policy. An empty golden trace is refused in
  that mode, because every run would match it.
- **A run cut off at `maxSteps` is an `error`,** not a finished run. Its partial
  trace is never classified.

## Library

```ts
import { collectToolCalls, runBehaviorCheck, formatBehaviorMarkdown } from 'agent-vcr'

const report = await runBehaviorCheck({
  runs: 5,
  baseline: {
    golden: goldenTrace.calls,
    variants: approved.variants,
    policy: { requires: [['refund_order', 'verify_order']], forbid: ['delete_account'] },
  },
  // One live run of your agent. Use any adapter, or your own loop.
  collect: () => collectToolCalls({ system, user, llm, executeTool }),
})

report.verdict // 'unchanged' | 'review' | 'regression' | 'inconclusive'
report.newPaths // distinct unapproved paths, most frequent first
report.regressions // distinct policy-breaking paths, with the rule each broke
console.log(formatBehaviorMarkdown(report))
```

`classifyBehavior(runs, baseline)` does the same on runs you already have, and
`classifyRun(calls, baseline)` classifies a single trace.

## Running only when it matters

A fingerprint hashes the inputs that decide what is run and how it is judged.
Commit it next to the golden trace. CI recomputes it and runs live only when it
differs.

The CLI fingerprint covers exactly these:

| Component | Source |
|---|---|
| `system`, `user`, `tools` | The record config |
| `model` | The record config or `--model` |
| `params` | Endpoint (`baseURL` or `--base-url`) and `maxSteps` |
| `policy` | `--policy` |
| `extra.stubs` | Stubbed tool results in the record config |
| `extra.golden`, `extra.variants`, `extra.mode` | `--golden`, `--variants`, `--mode` |

Anything else is invisible to it. Pass the same `--policy`, `--golden`,
`--variants` and `--mode` to `fingerprint` that you pass to `behavior`; a
component present on one side only counts as changed, so a mismatch makes the
check run instead of skipping.

```bash
# on your main branch, after you have accepted the current behaviour
npx agent-vcr fingerprint --config record.config.json --policy policy.json \
  --golden traces/refund.expected.json --variants traces/refund.variants.json \
  --out traces/refund.fingerprint.json

# exits 0 without calling the model when nothing changed
npx agent-vcr behavior --config record.config.json --golden traces/refund.expected.json \
  --variants traces/refund.variants.json --policy policy.json \
  --fingerprint traces/refund.fingerprint.json --if-changed
```

**Compare against the base branch, never the pull request's own copy.** A pull
request that changes the prompt can also regenerate the fingerprint file. If CI
compared against the file in that same checkout, the two would match and the
check would skip the very change it exists to catch. The workflow below reads
the fingerprint from the base branch for this reason.

The fingerprint stores hashes only, so a confidential prompt is not exposed by
committing it. Components are hashed separately, so the report names what
changed (`system`, `tools`) and not just that something did. Reordering the
tool list counts as a change; reordering keys inside a schema does not.

From code, pass anything else that steers behaviour through `extra`:

```ts
import { fingerprintInputs, changedComponents } from 'agent-vcr'

const current = fingerprintInputs({ system, model, tools, policy, params: { temperature: 0 }, extra: { routerTable } })
changedComponents(committed, current) // e.g. ['extra.routerTable', 'system']
```

What a fingerprint cannot see: a provider changing the weights behind an
unchanged model name. Pin dated model identifiers, or run the check on a
schedule as well.

## CLI

```bash
npx agent-vcr behavior --config record.config.json --golden traces/refund.expected.json \
  --policy policy.json --variants traces/refund.variants.json \
  --runs 5 --markdown behavior.md --json behavior.json --out-dir behavior-paths
```

`behavior` reuses the `record` config, so the agent it runs is the one `record`
runs: an OpenAI-compatible endpoint with stubbed tool results. For an agent with
its own loop or real tools, use the library form above.

The policy file is a JSON `TraceAssertion`:

```json
{
  "requires": [["refund_order", "verify_order"]],
  "forbid": ["delete_account"],
  "maxCallsPerTool": 3
}
```

Anything not understood in a policy file is an error: an unknown rule, an
unknown key inside a `{ "name", "args" }` pattern, or a file with no rules in
it. A misspelt rule would otherwise enforce nothing and report success.
`grounding` and `survival` rules need run-time evidence and are available from
code only.

Approving a new path is always an explicit step:

```bash
npx agent-vcr accept --variants traces/refund.variants.json \
  --trace behavior-paths/3f9a1c2e.json --name verify-first \
  --note "Verifying before the lookup is fine" --policy policy.json
```

With `--policy`, `accept` refuses a path that breaks policy.

## Pull requests

`--markdown` writes a comment body: the verdict, the first point where behaviour
left the golden trace, the rule that was broken, and the command to approve each
new path. Tool names, arguments, policy messages and error text are rendered as
code, flattened to one line and length-limited, so they cannot inject markdown
or mentions into the comment.

A workflow that runs the check only when inputs changed and keeps one comment up
to date:

```yaml
name: Agent behaviour
on:
  pull_request:
    paths: ['record.config.json', 'policy.json', 'traces/**', 'src/agent/**']

permissions:
  contents: read
  pull-requests: write

jobs:
  behavior:
    # Pull requests from forks get no secrets and a read-only token.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: npm ci

      # The trusted fingerprint is the one on the base branch. If it does not
      # exist there yet, the file is left absent and the check always runs.
      - name: Read the base branch fingerprint
        run: |
          git show "origin/${{ github.base_ref }}:traces/refund.fingerprint.json" > base.fingerprint.json \
            || rm -f base.fingerprint.json

      - name: Live behaviour check
        id: behavior
        continue-on-error: true
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: |
          npx agent-vcr behavior \
            --config record.config.json \
            --golden traces/refund.expected.json \
            --variants traces/refund.variants.json \
            --policy policy.json \
            --fingerprint base.fingerprint.json --if-changed \
            --runs 5 --markdown behavior.md --out-dir behavior-paths

      - name: Comment on the pull request
        if: hashFiles('behavior.md') != ''
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh pr comment "${{ github.event.pull_request.number }}" --body-file behavior.md --edit-last --create-if-none

      - name: Keep the new paths for review
        if: hashFiles('behavior-paths/*.json') != ''
        uses: actions/upload-artifact@v4
        with:
          name: behavior-paths
          path: behavior-paths

      - name: Fail on regression
        if: steps.behavior.outcome == 'failure'
        run: exit 1
```

Notes on that workflow:

- Pull requests from forks do not receive secrets, so the job is skipped for
  them. Do not switch to `pull_request_target` to work around it: that would run
  untrusted code with your API key.
- `--edit-last` updates the most recent comment by the workflow's own account,
  which may belong to another workflow if several comment on the same pull
  request. Each body starts with the marker `<!-- agent-vcr:behavior -->` so you
  can find the right comment yourself in that case.
- When a later push leaves the inputs unchanged from the base branch, the check
  skips and writes no comment, so an earlier comment stays as it was.
- Regenerate and commit the fingerprint on the base branch after merging a
  change you have accepted. Until then the check keeps running on every pull
  request, which is the safe direction.
- Live runs are not deterministic. Five runs can miss a path that appears one
  time in twenty. Treat `unchanged` as "no change seen in N runs", and raise
  `--runs` for scenarios where a rare failure is expensive.

## Try it

```bash
npm run example:live-behavior   # no model needed; shows each verdict and the PR comment
npm run live:behavior           # real model via local Ollama; see scripts/live/README.md
```
