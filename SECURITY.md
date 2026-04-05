# Security

## Supported versions

Only the **latest minor** on `main` is actively maintained.

## Reporting a vulnerability

Please open a **private** GitHub security advisory for this repository, or email the maintainer with:

- Description and impact
- Steps to reproduce
- Suggested fix (optional)

Do not open public issues for undisclosed security bugs.

## Secrets and API keys

- **Never** commit OpenAI (or other) API keys, `.env` files with real tokens, or service credentials to this repository.
- If a key is ever exposed (chat, screenshot, public issue), **revoke it immediately** in the provider’s dashboard and issue a new key.
- For `agent-vcr record`, use environment variables on your machine or your CI provider’s secret store — not hard-coded strings in source.
