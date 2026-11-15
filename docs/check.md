# `check` and the GitHub Action

`agent-vcr check` judges runs that already happened against your policy and
golden traces. It makes no model calls and needs no API key, so it can gate every
pull request. The GitHub Action in this repository wraps it.

Use it when you have traces from somewhere: recorded by Agent VCR, exported as
OpenTelemetry spans from an agent in any framework or language, or written by
your own test harness. For asking a live model what it does now, see
[live behaviour checks](live-behavior.md).

## The suite file

A suite lists the runs to judge. Paths are relative to the suite file.

```json
{
  "version": 1,
  "name": "refund agent",
  "policy": "policy.json",
  "scenarios": [
    { "name": "refund happy path", "trace": "traces/refund.run.json", "golden": "traces/refund.expected.json" },
    { "name": "python agent", "otel": "traces/spans.json", "traceId": "5b8efff798038103d269b633813fc60c" }
  ]
}
```

| Scenario key | Meaning |
|---|---|
| `name` | Required, unique |
| `trace` | An Agent VCR trace file holding the run. Give exactly one of `trace` and `otel` |
| `otel` | An exported OpenTelemetry span file holding the run |
| `traceId` | Which trace in the span file, when it holds several |
| `namesOnly` | Accept spans with no recorded arguments |
| `golden` | Golden trace to compare with |
| `variants` | Approved alternative paths |
| `policy` | Policy file; overrides the suite-level `policy` |
| `mode` | `exact` (default) or `subsequence` |

The policy file format is described in [live behaviour checks](live-behavior.md#cli).

## Results

Each scenario ends in one status.

| Status | Meaning |
|---|---|
| `pass` | Matches the golden trace or an approved path. With no golden trace: breaks no policy rule |
| `review` | A path nobody has approved that breaks no policy rule |
| `fail` | Breaks a policy rule |
| `error` | Could not be evaluated |

| Verdict | When | Exit code |
|---|---|---|
| `fail` | Any scenario is `fail` or `error` | 1 |
| `review` | No failures, at least one `review` | 0, or 1 with `--strict` |
| `pass` | Everything passed | 0 |

A suite file that cannot be read or is malformed exits 2.

`error` fails the check on purpose. These all produce one, instead of a pass:

- a missing or unparseable trace, span, policy or golden file
- a scenario with neither a policy nor a golden trace, which would check nothing
- a run with no tool calls judged by policy alone, since an empty run satisfies every `forbid` and `requires` rule. To assert that an agent should call nothing, give a golden trace with no calls
- the same file given as both `trace` and `golden`
- a policy with an unknown rule or no rules
- spans with no recorded arguments, unless `namesOnly` is set
- `namesOnly` together with a policy that checks arguments, or with a golden trace
- a span file with no tool spans, several traces and no `traceId`, or unreadable start times

Unknown or duplicate keys in the suite file are refused for the same reason, as are `variants` or `mode` without a `golden` trace.

Paths may point anywhere the process can read, including outside the repository. The check only reads them, and records each file's sha256 in the report.

## Output

```bash
npx agent-vcr check --suite agent-vcr.suite.json --out-dir report
```

`--out-dir` writes three files.

| File | Contents |
|---|---|
| `results.json` | The full result: verdict, every scenario, and a sha256 of each input file |
| `report.md` | Summary for a job summary or pull-request comment |
| `report.html` | Self-contained page: no scripts, no external resources |

The hashes tie a report to the exact traces and policy that were judged. They
are not a signature and do not show who ran the check.

## GitHub Action

```yaml
name: Agent checks
on: pull_request

permissions:
  contents: read
  pull-requests: write # only needed for comment: true

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: ajayvnkt/agent-vcr@main
        with:
          suite: agent-vcr.suite.json
          comment: true
```

Pin the action to a commit SHA instead of `main` once you depend on it.

| Input | Default | Meaning |
|---|---|---|
| `suite` | required | Path to the suite file |
| `strict` | `false` | Also fail on an unapproved path |
| `comment` | `false` | Post the result as a pull-request comment |
| `artifact-name` | `agent-vcr-report` | Name of the uploaded report; empty skips the upload |
| `github-token` | the workflow token | Token used for the comment |

| Output | Meaning |
|---|---|
| `verdict` | `pass`, `review` or `fail` |
| `has-report` | `true` when the report files were written |
| `report-dir` | Directory holding the three report files |

The result is always written to the job summary. The action builds the CLI from
its own checkout, which takes about half a minute and means it does not depend on
an npm release. It also sets up Node 22 for the rest of the job.

The comment is found by a hidden marker and updated in place, so it does not
touch comments from other workflows. Pull requests from forks get a read-only
token, so the comment step fails there and is ignored; the check itself still
runs, because it needs no secrets. If you use the action more than once in a
job, give each use its own `artifact-name`.

## One policy, two tools

The policy format is meant to be implemented more than once; a Python
implementation exists in Agent Arena. [`conformance/policy-cases.json`](../conformance/policy-cases.json)
is the contract: for each case an implementation must report exactly the listed
failure kinds, and it must reject every policy under `invalid`.

Two points an implementation must match:

- Values are compared, and non-string values are searched by `contains` and
  `matches`, in canonical JSON: keys sorted, no whitespace, integral numbers
  written without a decimal point.
- `matches` is a regular expression searched anywhere in the text. This
  implementation uses JavaScript's engine, so keep patterns to syntax your
  engines share.
