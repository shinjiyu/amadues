# Amadues

> **Language:** [中文](./README.md) · English (this page)

> **An AI digital worker that stays on the clock, never loses its memory on restart, and gets smarter the more you use it.**
> Not a "feed-it-a-prompt" tool — an executor with persistent goals that plans autonomously and collaborates naturally with people.

**Amadues** is a long-running agent stack: the **outer brain** handles dialogue policy and tool calls, the **inner brain (Pi-mono / DyFlow)** decomposes a goal into nodes and executes them, and everything is persisted as **File as Context** — **restart the process and the task resumes right where it left off.**

## What it fixes

| Common pain | Amadues |
|-------------|---------|
| Must @ it to respond; multiple agents bicker in a group | **Decides when to join** on its own; instances split work naturally |
| Context blows up as tasks grow long | **Long tasks don't blow context** — execution state stays clear |
| Chat and work bleed into each other | **Conversation is conversation, work is work** |
| Dispatch a task and it stalls | **Execution never blocks chat**; reports back when done |
| Restart the process, lose everything | **Crash-resumable**: state, memory and deliverables all on disk |
| Steps on the same rake over and over | **Gets smarter**: experience distilled into reusable, cross-agent skills |

> Field highlights: cracking a site's login + continuous scraping from **zero prior knowledge**, **spawning multiple cooperating executors** for big tasks, and auto-distilling "pitfall" constraints after failures. See [`doc/amadues-capabilities.md`](./doc/amadues-capabilities.md).

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
