# 1. Structurizr DSL 作为架构 ADL 权威

## Status

Accepted

## Context

Kuroneko 为多通道 Agent 单体仓库，需要可版本化的 C4 模型，并与实现路径、集成类型（HTTP/spawn/file）对齐。

## Decision

- 以 `doc/structurizr/workspace.dsl` 为 **ADL 权威**（L1/L2/L3 + `horizon.*` 契约）。
- Mermaid 实现细节图保留在 `doc/architecture.md`，不替代 DSL。
- 代码扫描仅生成 `generated/workspace.generated.dsl` 供 diff，不直接覆盖手写 DSL。

## Consequences

- 架构变更须同步更新 DSL 与 `modules-catalog.md`。
- CI/本地可用 `validate` + `inspect` 做模型 lint。
