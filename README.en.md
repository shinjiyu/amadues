# Kuroneko (Ilya)

> **Language:** [中文](./README.md) · English (this file)

Greenfield agent stack: **durable data**, **identity + Chat IR**, **outer / inner brain (Pi-mono)**, **web dashboard**, and **WebChat H5**. Product name: **Ilya (Kuroneko / 依莉雅)**.

Documentation index: [`doc/README.md`](./doc/README.md) (architecture, inner–outer protocol, channel bridges, testing, Structurizr ADL, ops).

## Requirements

- Node.js ≥ 20
- On Windows dev machines, use **`hutao`** instead of plain `git` for push (see [`doc/ops/git-workflow.md`](./doc/ops/git-workflow.md))

## Local services

| Service | Command / notes | URL |
|---------|-----------------|-----|
| **Kuroneko Agent** | `npm run dev:server` (`.env`) | API http://127.0.0.1:8787 |
| **Shiro Agent** | `npm run dev:agent2` (`.env.agent2`) | API http://127.0.0.1:8788 |
| **Gin Agent** | `npm run dev:gin` (`.env.gin`) | API http://127.0.0.1:8789 |
| **Dashboard** | `npm run dev:dashboard` | http://127.0.0.1:5173 (`/api`→8787, `/api2`→8788, `/api3`→8789) |
| **Chat Server** | `npm run dev:chat-server` | http://127.0.0.1:8790 |
| **Web Chat H5** | `npm run dev:web-chat` | http://127.0.0.1:5180 |
| **Ops Console** | `npm run dev:ops` | http://127.0.0.1:7779 (dual-agent logs) |

All six Kuroneko services can also be started from **local-dashboard** (`http://127.0.0.1:9780/?page=kuroneko`). See [`doc/ops/local-dashboard.md`](./doc/ops/local-dashboard.md).

## Install & develop

```powershell
cd D:\kuroneko
copy .env.example .env
# Edit .env: LLM keys, channel (Discord or WebChat), etc.; copy to .env.agent2 for Shiro

npm install
npm run build
npm run dev          # 8787 + Dashboard
```

Common partial starts:

```powershell
npm run dev:server       # Kuroneko
npm run dev:agent2       # Shiro (separate data-shiro)
npm run dev:gin          # Gin (separate data-gin)
npm run dev:webchat-all  # chat-server + Web Chat H5
npm run dev:ops          # Ops log console
```

**Offline debugging** (no channel configured): `POST http://127.0.0.1:8787/api/outer/roundtrip` runs a full outer-brain roundtrip and writes `<UTLRA_DATA_ROOT>/chat/threads.json`.

## LLM configuration (`.env` / `.env.agent2`)

Configure **at least one** text model (see [`.env.example`](./.env.example)):

| Provider | Typical vars | Notes |
|----------|--------------|-------|
| **Zhipu GLM** | `ZHIPU_API_KEY`, `ZHIPU_MODEL=glm-5.1` | Coding Plan needs `ZHIPU_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4` |
| **LocalModule** | `LOCALMODULE_API_KEY`, `UTLRA_INNER_LLM_PROVIDER=localmodule` | OpenAI-compatible endpoint (e.g. PocketCity) |
| **Kimi** | `KIMI_API_KEY` | Moonshot OpenAI-compatible |

**Never** commit `.env` / `.env.agent2`. Rotate keys immediately if leaked.

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

Three agents sharing chat-server: copy `.env.chat-server.example` → `.env.chat-server` (`WEBCHAT_AGENT_USER_ID=kuroneko,shiro,gin`), then `npm run dev:chat-server`. Match `WEBCHAT_AGENT_SECRET` in each agent env file.

## Tests & architecture

```powershell
npm test
npm run test:server:integration
npm run structurizr:check
```

Conventions: [`doc/how-to-write-tests.md`](./doc/how-to-write-tests.md), [`doc/testing-strategy.md`](./doc/testing-strategy.md).

## Git sync

On Windows, use **`hutao`** (see [`doc/ops/git-workflow.md`](./doc/ops/git-workflow.md)):

```powershell
hutao status -sb
hutao push origin main
```

Use GitHub PAT or SSH for credentials. **Do not paste tokens** into docs or chat.

---

Runtime data (`packages/server/data/`, `data-shiro/`, `apps/chat-server/data/`) is listed in `.gitignore` and is not committed.
