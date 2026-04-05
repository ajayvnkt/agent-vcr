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

## Security

See [SECURITY.md](./SECURITY.md) for reporting vulnerabilities.
