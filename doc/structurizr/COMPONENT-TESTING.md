# 按 Structurizr Component 设计测试

> **原则**：ADL 里每个 L3 `component` = 一个可测契约；测试文件与 `modules-catalog.md` 的 `module ID` 对齐，而不是隐没在「外脑一大坨」里。

## 文件命名

| 类型 | 后缀 | 放哪 |
|------|------|------|
| 组件单元（纯函数，仅本组件源文件） | `*.component.test.ts` | 与 `properties.path` 主文件同目录 |
| 组件黑盒（In→Out，可 FakeLLM / 临时盘） | `*.component.integration.test.ts` | 同上，或 `src/integration/components/<moduleId>.ts` |
| Prompt 效果（真实 LLM） | `*.component.prompt.test.ts` | 同目录 |

`describe` 根块固定：

```ts
describe('component: participationPolicy', () => { ... });
```

文件头注释（必填）：

```ts
/**
 * ADL: participationPolicy
 * path: packages/server/src/outer/inbound-policy.ts
 * horizon.in:  OuterInboundMeta + threadId + content
 * horizon.out: shouldReply + reason
 */
```

## 用例设计模板（每个 component 一张表）

| # | 场景 | horizon.in（摘要） | horizon.out（断言） | 层级 |
|---|------|-------------------|---------------------|------|
| 1 | 主路径 | 最小合法输入 | 契约字段 | integration |
| 2 | 拒绝路径 | 边界 / 空 / 无权 | shouldReply=false + reason | unit 或 integration |
| 3 | 依赖注入 | FakeLLM / mock config | 不触网 | unit |
| 4 | prompt 形态 | 需真实 LLM 时 | SPEAK/SILENT 可解析 | prompt |

**不必**为每个 component 各写 50 条；先 **1 条主路径 + 1 条拒绝路径**，再按变更扩表。对照表见 [`COMPONENT-TEST-MAP.md`](./COMPONENT-TEST-MAP.md)。

## 与 `testing-strategy.md` 的关系

- §4 矩阵**保留**，按职责聚合统计。
- **新增**：以 `module ID` 为行的 [`COMPONENT-TEST-MAP.md`](./COMPONENT-TEST-MAP.md) 为 ADL 侧权威清单。
- 合并前规则：每个 ADL component 至少在 MAP 里有一行，且至少一种测试层级不是 ❌（除纯装配壳如 `llmGateway` 可 🟡 由子 provider 覆盖）。

## DSL 可选属性（文档约定，逐步写入 `*.dsl`）

```text
horizon.test.unit        → *.component.test.ts
horizon.test.integration → *.component.integration.test.ts
horizon.test.prompt      → *.component.prompt.test.ts
```

## CI

- 单元：`npm run test:unit`（含 `*.component.test.ts` 若与 `*.test.ts` 同目录，已包含在默认 include）
- 组件黑盒：`npm run test:integration`（含 `*.component.integration.test.ts`）
- ADL：`npm run structurizr:check`
