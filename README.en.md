# Kuroneko (Ilya)

> **Language:** [中文](./README.md) · English (this file)

Greenfield agent stack: **durable data**, **identity + Chat IR**, **outer / inner brain (Pi-mono)**, **web dashboard**, and **WebChat H5**. Product name: **Ilya (Kuroneko / 依莉雅)**.

Documentation index: [`doc/README.md`](./doc/README.md) (architecture, inner–outer protocol, channel bridges, testing, Structurizr ADL, ops).

## Requirements

- Node.js ≥ 20
- Docker (for running agents in containers)

## Local services

| Service | Command / notes | URL |
|---------|-----------------|-----|
| **Kuroneko Agent** | `npm run docker:agents:up:kuroneko` | API http://127.0.0.1:8787 |
| **Shiro Agent** | `npm run docker:agents:up:shiro` | API http://127.0.0.1:8788 |
| **Gin Agent** | `npm run docker:agents:up:gin` | API http://127.0.0.1:8789 |
| **Aoi Agent** | `npm run docker:agents:up:aoi` | API http://127.0.0.1:8791 |
| **Dashboard** | `npm run dev:dashboard` | http://127.0.0.1:5173 (`/api`→8787 … `/api4`→8791) |
| **Chat Server** | `npm run dev:chat-server` | http://127.0.0.1:8790 |
| **Web Chat H5** | `npm run dev:web-chat` | http://127.0.0.1:5180 |
| **Ops Console** | `npm run dev:ops` | http://127.0.0.1:7779 |

Optional host-level process UI: **local-dashboard** on port 9780 — see [`doc/ops/local-dashboard.md`](./doc/ops/local-dashboard.md).

## Install & develop

```bash
git clone <repo-url> kuroneko && cd kuroneko
# Copy deploy/agent/env/*.example → deploy/agent/env/*.env and fill secrets (see doc/ops/agent-docker.md)
npm install
npm run build
npm run docker:agents:up    # all four agents (Docker)
npm run dev:dashboard       # monitoring UI
```

Common commands:

```bash
npm run docker:agents:up          # all agents
npm run docker:agents:up:aoi      # single agent
npm run docker:agents:down        # stop all agent containers
npm run dev:dashboard
npm run dev:webchat-all           # local chat-server + H5 (optional)
npm run dev:ops
```

Agents run **only in Docker**; see [`doc/ops/agent-docker.md`](./doc/ops/agent-docker.md). Legacy `dev:server` / `dev:agent2` npm scripts are removed.

**Offline debugging** (no channel configured): `POST http://127.0.0.1:8787/api/outer/roundtrip` runs a full outer-brain roundtrip and writes `<UTLRA_DATA_ROOT>/chat/threads.json`.

## LLM configuration

Per-agent secrets live in `deploy/agent/env/<name>.env` (not committed). At least one text model is required — see [`deploy/agent/env/kuroneko.env.example`](./deploy/agent/env/kuroneko.env.example) and [`.env.example`](./.env.example).

| Provider | Typical vars | Notes |
|----------|--------------|-------|
| **Zhipu GLM** | `ZHIPU_API_KEY`, `ZHIPU_MODEL=glm-5.1` | Coding Plan needs `ZHIPU_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4` |
| **LocalModule** | `LOCALMODULE_API_KEY`, `UTLRA_INNER_LLM_PROVIDER=localmodule` | OpenAI-compatible endpoint |
| **Kimi** | `KIMI_API_KEY` | Moonshot OpenAI-compatible |

**Never** commit `deploy/agent/env/*.env` or root `.env*`. Rotate keys immediately if leaked.

Smoke tests: `npm run smoke:zhipu` / `npm run smoke:zhipu:vision`.

## Pi-mono inner brain

Pi-mono is **embedded** in `packages/server/src/openkuroneko/` (DECOMPOSE / EXECUTE / ATTRIBUTE / AWAITING, etc.). No external `OPENKURONEKO_DIST`.

- **Single tick**: `POST /api/inner/:ws/pi-tick`
- **Auto burst**: `POST /api/inner/:ws/pi-auto`, body `{ "maxTicks": 500 }`
- Authoritative goal: `.brain/goal.md`

Use the Dashboard **inner brain** page to set goals, tick, and inspect state.

## Outer brain & repository

- `GET /api/outer/inner-status/:ws` — aggregated inner status  
- `POST /api/outer/roundtrip` — set goal → subprocess Pi-mono Auto → `StructuredReply`  
- `POST /api/outer/workspace/:ws/shutdown` — promote manifest / sleep  

See [`doc/inner-outer-protocol.md`](./doc/inner-outer-protocol.md).

Repository (execution / interaction lanes): `POST /api/repository/:tenant/commit|retrieve`.

## Channels: Discord / WebChat

- **`@utlra/chat-ir`** — messages, threads, identities  
- **`@utlra/discord-bridge`** — `UTLRA_CHAT_CHANNEL=discord` + `DISCORD_BOT_TOKEN`  
- **`@utlra/webchat-bridge`** + **`apps/chat-server`** + **`apps/web-chat`** — `UTLRA_CHAT_CHANNEL=webchat`  

Guides: [`doc/channel-bridge-guide.md`](./doc/channel-bridge-guide.md), [`doc/chat-ir-identity-design.md`](./doc/chat-ir-identity-design.md).

For local WebChat: `npm run dev:webchat-all`. For production, point each agent env at your chat-server base URL (`WEBCHAT_API_BASE` / `WEBCHAT_WS_URL`) and align `WEBCHAT_AGENT_SECRET` with the server.

## Tests & architecture

```bash
npm test
npm run test:server:integration
npm run structurizr:check
```

Conventions: [`doc/how-to-write-tests.md`](./doc/how-to-write-tests.md), [`doc/testing-strategy.md`](./doc/testing-strategy.md).

## Contributing & Git

Standard `git` workflow; see [`doc/ops/git-workflow.md`](./doc/ops/git-workflow.md) for Windows credential notes.

```bash
git status -sb
git push origin main
```

Use GitHub PAT or SSH for credentials. **Do not paste tokens** into docs or chat.

---

Runtime data (`packages/server/data/`, `data-shiro/`, `data-gin/`, `data-aoi/`, `apps/chat-server/data/`) is in `.gitignore` and is not committed.
