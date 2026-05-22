---
name: structurizr-codegen
description: >-
  Generates Structurizr workspace.dsl from Kuroneko code (granularity presets)
  and diffs two DSL files for architecture drift. Use when the user asks to
  reverse-engineer C4 from code, sync DSL with packages, compare Structurizr
  models, or prevent granularity drift in ADL generation.
---

# Structurizr code → DSL + diff

Structurizr does **not** ship TypeScript reverse-engineering. This project uses **manifest-driven** generators under `scripts/structurizr/`.

## When to use

- User wants **DSL from codebase** (with explicit **granularity**).
- User wants **diff** between authoritative `workspace.dsl` and generated (or two branches).
- User mentions **granularity drift**, **ADL sync**, **architecture diff**.

## Granularity parameter (required)

Always pass `--granularity <preset>`. **Never** default to full L3 without user intent.

| Preset | Output |
|--------|--------|
| `l1` | Person + Kuroneko + external systems only |
| `l2` | L2 containers/libraries (packages/apps manifest) |
| `l2-imports` | L2 + `import` edges from `package.json` `@utlra/*` deps |
| `l3-outer` | L2 + L3 inside `agentServer` (manifest) |
| `l3-inner` | L2 + L3 inside `innerWorker` (manifest) |
| `l3-full` | L2 + all L3 + imports + internal L3 edges |

List presets: `npm run structurizr:generate -- --list`

**Drift control**: L3 modules are defined only in `scripts/structurizr/manifest.mjs` (not inferred from every `.ts` file). To add a module, edit manifest + `doc/structurizr/modules-catalog.md`, then regenerate.

## Commands

```bash
# Generate (default out: doc/structurizr/generated/workspace.generated.dsl)
npm run structurizr:generate -- --granularity l2-imports

# Diff authoritative vs generated (exit 1 if drift)
npm run structurizr:diff -- --left doc/structurizr/workspace.dsl --right doc/structurizr/generated/workspace.generated.dsl

# Validate with Structurizr (Java)
cd doc/structurizr && run-war.bat validate -workspace generated/workspace.generated.dsl
```

## Workflow for agents

1. Ask or infer **granularity** if user did not specify (prefer `l2-imports` for CI gate, `l3-full` only for deep reviews).
2. Run `structurizr:generate` with that granularity.
3. Run `structurizr:diff` against `doc/structurizr/workspace.dsl`.
4. Present summary: added/removed elements and relationships.
5. **Do not** overwrite `workspace.dsl` automatically — human merges intentional ADL (horizon props, views, external labels).

## Extending the generator

| File | Purpose |
|------|---------|
| `scripts/structurizr/manifest.mjs` | L2/L3 ids, paths, granularity presets |
| `scripts/structurizr/code-to-dsl.mjs` | CLI: scan package.json, emit DSL |
| `scripts/structurizr/diff-workspace.mjs` | CLI: diff two `.dsl` files |
| `scripts/structurizr/parse-dsl.mjs` | Shared DSL subset parser |

## Limitations

- Parser is **not** full Structurizr DSL (no `!include` expansion in diff — flatten or diff single files).
- Import edges = **package.json** only (not dynamic `import()` paths).
- L3 does not auto-discover new files; manifest update required.
- Cross-process `llm` usage may differ between hand model and generated.

## Related docs

- `doc/structurizr/GRANULARITY.md` — C4 level rules
- `doc/structurizr/modules-catalog.md` — human-readable module contracts
- `doc/structurizr/REFACTOR-PLAN.md` — P2 dependency-cruiser (complements import diff)
