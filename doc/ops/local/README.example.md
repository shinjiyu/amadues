# 本机运维说明（不提交仓库）

`doc/ops/local/` 用于存放 **仅本机/内网** 的部署笔记，例如：

- 固定端口号与 Dashboard 代理对照表
- 域名、VPS、SSH、nginx 完整 server 块
- local-dashboard（9780）注册与 sync 脚本路径
- 多环境 WebChat lab 子路径

## 用法

```bash
mkdir -p doc/ops/local
cp doc/ops/local/README.example.md doc/ops/local/notes.md
# 编辑 notes.md — 该目录已在 .gitignore，不会 push
```

公开文档请使用通用表述，见：

- [../deploy/agent-quickstart.md](../deploy/agent-quickstart.md)
- [agent-docker.md](../agent-docker.md)
- [webchat-deploy.md](../webchat-deploy.md)
