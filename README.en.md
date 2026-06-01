# Amadues

> **Language:** [中文](./README.md) · English (this page)

**Amadues** is a long-running agent stack: durable data, Chat IR, outer / inner brain (Pi-mono), optional WebChat or Discord channels, and a web ops console.

Documentation index: [doc/README.md](./doc/README.md)

## Requirements

- Node.js ≥ 20
- Docker (recommended for running the agent server)

## Quick start

```bash
git clone <repo-url> amadues && cd amadues
npm install
npm run build
```

**Deploy one agent instance** (Docker, env, channel secrets):

👉 **[doc/deploy/agent-quickstart.md](./doc/deploy/agent-quickstart.md)**

## Repository layout

| Path | Role |
|------|------|
| `packages/server` | Agent server (outer brain, inner brain, HTTP API) |
| `packages/chat-ir` | Chat intermediate representation |
| `packages/webchat-bridge` / `discord-bridge` | IM channel adapters |
| `apps/chat-server` / `apps/web-chat` | Standalone WebChat backend + H5 |
| `apps/dashboard` | Read-only monitoring UI |
| `deploy/agent` | Docker Compose and env templates |

## Features

- **Outer brain:** participation policy, tools, task dispatch, structured replies
- **Inner brain:** embedded Pi-mono controller (DECOMPOSE / EXECUTE / AWAITING, …)
- **Repository:** execution / interaction knowledge lanes
- **Channels:** `UTLRA_CHAT_CHANNEL=webchat | discord | none`

See [doc/inner-outer-protocol.md](./doc/inner-outer-protocol.md) and [doc/architecture.md](./doc/architecture.md).

## Development & tests

```bash
npm test
npm run test:server:integration
npm run structurizr:check
```

Conventions: [doc/how-to-write-tests.md](./doc/how-to-write-tests.md) · [doc/testing-strategy.md](./doc/testing-strategy.md)

## Configuration & security

- Instance secrets live in `deploy/agent/env/*.env` (**never commit**)
- Reference: [`.env.example`](./.env.example) · [`deploy/agent/env/agent.env.example`](./deploy/agent/env/agent.env.example)
- Optional smoke test: `npm run smoke:zhipu`

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Git notes: [doc/ops/git-workflow.md](./doc/ops/git-workflow.md)

## License

[MIT](./LICENSE)
