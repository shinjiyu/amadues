# Drive9 Explorer

Dropbox 风格的 Drive9 文件浏览器，用于可视化浏览 kuroneko 云端存储的技能、知识与约束文件。

## 功能

- 文件夹树导航（技能 / 知识 / 约束快捷入口）
- 网格 / 列表视图切换
- 面包屑路径导航
- 语义搜索（drive9 vector + BM25）
- 文件预览、上传、删除

## 前置条件

配置 Drive9 API（任选其一）：

```bash
# 方式 1：环境变量（本地自建优先；scripts/local-dashboard 会加载 .env.kuroneko）
DRIVE9_API_KEY=kuroneko-local-...
DRIVE9_SERVER=http://127.0.0.1:9009

# 方式 2：CLI 配置
# ~/.drive9/config 中设置 current_context
```

## 启动

```bash
# 从仓库根
npm run dev:drive9

# 或进入工具目录
cd tools/drive9-explorer && npm run dev
```

- 前端：http://127.0.0.1:7782
- API 代理：http://127.0.0.1:7780

## 架构

```
tools/drive9-explorer/
├── src/server.ts      # Hono 本地代理（隐藏 API Key）
└── web/               # Vite + React 前端
```

后端复用 `packages/server/src/drive9/drive9-client.ts`，与 agent 使用同一套认证逻辑。
