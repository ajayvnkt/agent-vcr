# Contributing

Thanks for contributing to **Agent VCR**. Stack: strict TypeScript, Vitest, GitHub Actions on Node 18 / 20 / 22.

## Setup

```bash
git clone <your-fork>
cd agent-vcr
npm install
```

Requires **Node.js ≥ 18**.

## Commands

```bash
npm run build        # Compile src/ → dist/
npm run dev          # Watch mode
npm run lint         # tsc --noEmit (strict)
npm test             # vitest run
npm run example:minimal   # Requires dist/ (run build first)
```

## Pull requests

1. Branch from `main`.
2. Add or update **tests** for behavior changes.
3. Run `npm run lint && npm test && npm run build` locally.
4. Keep **dependencies minimal**; justify new runtime deps in the PR.

## Style

- TypeScript **strict**, ES modules, **`.js` extensions** in relative imports under `src/`.
- Prefer **small modules** with a short `@fileoverview` at the top (see `src/`).
- No network or API keys in unit tests.

## Releases / npm

Publishing is automated when you push a **version tag** that matches `package.json`:

1. Bump `"version"` on `main` and commit (e.g. `chore: release v0.3.2`).
2. Tag: `git tag v0.3.2` (must match the version string exactly, with `v` prefix).
3. `git push origin main --tags`

The workflow [`.github/workflows/publish-npm.yml`](.github/workflows/publish-npm.yml) runs `lint`, `test`, and `npm publish`.

**Tag push:** Pushing to `main` only runs **CI**. To run **Publish npm**, push a matching tag (e.g. `v0.3.1` must equal `package.json` version) **or** open **Actions → Publish npm → Run workflow**, choose branch `main`, and run (manual runs skip the tag check).

**One-time setup:** In the GitHub repo, add a secret **`NPM_TOKEN`** (Settings → Secrets and variables → Actions). Use a **classic Automation** token (or a granular token that explicitly allows **publishing the unscoped package `agent-vcr`**). A token limited to a scope like `@agentvcr/*` **cannot** publish the global name `agent-vcr`.

To publish from your machine instead: `npm login` then `npm publish`.

## Security

See [SECURITY.md](./SECURITY.md) for reporting vulnerabilities.
