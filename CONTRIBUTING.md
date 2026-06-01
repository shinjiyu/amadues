# Contributing to Amadues

Thank you for your interest in contributing.

## Development setup

```bash
git clone <repo-url> amadues && cd amadues
npm install
npm run build
npm test
```

Deploy a single agent instance: [doc/deploy/agent-quickstart.md](doc/deploy/agent-quickstart.md).

## Pull requests

1. Fork and create a feature branch from `main`.
2. Keep changes focused; match existing TypeScript / test style.
3. Run `npm test` and, for server changes, relevant integration tests.
4. Do **not** commit secrets, runtime data (`packages/server/data*/`, `deploy/agent/env/*.env`), or machine-specific notes under `doc/ops/local/`.
5. Update [doc/README.md](doc/README.md) if you add public documentation.

## Architecture changes

For structural changes, update `doc/structurizr/workspace.dsl` and run:

```bash
npm run structurizr:check
```

## Security

Never open a PR containing API keys, `WEBCHAT_AGENT_SECRET`, or production hostnames. Rotate any leaked credentials immediately.

## Questions

Open a GitHub issue with reproduction steps or design context.
