# Blender frog → H5（exec-agent 冒烟）

经本机 Blender addon HTTP 桥（默认 `127.0.0.1:11588`）用 bpy 做**精细有机体青蛙**、bake 材质、导出 GLB、three.js 展示。见 [`doc/structurizr/EXEC-AGENT.md`](../../doc/structurizr/EXEC-AGENT.md)。

题面按种子 skill `fine_organic_model` 编排（Skin → 闭壳 remesh → lookdev → bake → H5）。`run-blender-frog.ts` **每次清空 `work/`**。

## 前置

1. 打开 Blender，启用 **blender-meta-mcp** addon。
2. `curl -s http://127.0.0.1:11588/health` 返回 `ok`。

## 跑

```bash
npx --yes tsx packages/server/src/openkuroneko/exec-agent/run-blender-frog.ts
```

进度：`EXEC_AGENT_EXPERIMENT=exec-agent-blender-frog EXEC_AGENT_PROGRESS_PORT=8933` 起 `progress-server.ts`。

## 布局

| 路径 | 作用 |
|------|------|
| `instruction.md` | 题干（skill 流水线） |
| `seed/` | 开局 rules/skills/tools |
| `work/` | 运行时工作区（gitignore，每次 wipe） |
| `live/` | 进度事件（gitignore） |
| `saved/` | 人工/历史成品归档（gitignore；**勿放 work 下**） |
