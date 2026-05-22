# `packages/server/fixtures/`

测试夹具根目录。**禁止**在测试里写大段 inline JSON / Markdown；改放这里通过 `loadFixture(relative)` 读取（见 `src/testing/load-fixture.ts`）。

## 目录约定

```
fixtures/
  llm-replies/                       # LLM 响应脚本（FakeLLM scripts 也可读这里）
    decomposer-2-milestones.json
    attributor-cap-gap.json
  workspaces/                        # 完整 .brain + .run/pi-mono 工作区快照
    completed-with-deliverable/
      .brain/
        goal.md
        milestones.md
        knowledge.md
        reflexion.json
      .run/
        pi-mono/
          deliverables.json
          output
    awaiting-timer/
      .brain/
        controller-state.json        # mode=AWAITING
        pendings.json
  outbound-messages/                 # IM 出站消息 / 渲染对照
```

## 命名规范

- 文件名用 `<场景>-<关键差异>.json`：`decomposer-zero-milestones.json` / `attributor-with-cap-gap.json`
- 工作区子目录用一句话：`completed-with-deliverable` / `awaiting-timer` / `blocked-after-replan-limit`
- 每个一级子目录必须有 `README.md` 简述：为什么需要这份 fixture、被哪个测试引用

## 添加 fixture 的流程

1. 把数据从测试代码搬过来；保证 fixture 是**最小可重现状态**，不要塞业务无关字段。
2. 在所属测试的注释中标注：`// fixture: llm-replies/xxx.json`。
3. 大块 binary（图片 / pdf）不要进 fixture——用 `tools/` 生成或 mock。

## 不要做

- ❌ 在 fixtures/ 里堆生产数据快照（哪怕脱敏）。
- ❌ 用绝对路径 / `..` 读 fixture——一律走 `loadFixture(relative)`。
- ❌ 把 fixture 数据写成 `.ts` 模块（绕过 `loadFixture`，丢失"数据即文件"的语义）。
