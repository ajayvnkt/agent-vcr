# Portable build readiness

Run `node scripts/build-readiness.mjs` to build and test offline, then atomically emit
`artifacts/readiness.json`. An optional first argument selects the output file. A failed
build/test or source change during verification emits FAIL and exits nonzero, replacing
any prior success. This is a build attestation, not agent or candidate qualification.

Schema version 1 has required fields: `schema_version: 1`, `tool: "agent-vcr"`,
`build_status: "PASS" | "FAIL"`, nonnegative integer `test_count`, lowercase 64-digit
`source_sha256`, UTC ISO `generated_at`, string-array `capabilities`, and string `scope`.
The source digest hashes sorted relative path + NUL + file bytes + NUL for package.json,
package-lock.json, tsconfig.json, and regular files recursively under src, tests,
scripts and .github. It includes uncommitted source and excludes generated output.

Deliver a copy of this artifact to the consumer. Arena expects a local copy at
`<store>/artifacts/vcr/readiness.json`; it does not load VCR modules or inspect VCR's
repository. The receiver must trust the producer and artifact delivery: a SHA alone
is not a signature. Arena expires evidence after 24 hours and labels absent, invalid,
future-dated or expired evidence UNKNOWN. Regenerate and recopy after source changes.
