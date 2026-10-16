# Kura H5 seed（事后分析 → 下一轮）

来源：上次 complete 跑（~28.5m）的过程分析——未下完就 unzip、Chromium 路径空转、下载期零并发、vision 造轮子。

本目录在 `run-kura-h5.ts` place() 时拷入 `work/.agent/`。Agent **不能** `create_tool`；只能读这些 rules/skills（及可选 `tools.json`）。

| 文件 | 要点 |
|------|------|
| `rules/no_unzip_incomplete.md` | 等 zip 完整再解压 |
| `rules/no_foreground_big_curl.md` | 大包勿前台卡 120s |
| `rules/chrome_path_once.md` | 浏览器路径只 resolve 一次 |
| `skills/download_unpack/SKILL.md` | 下载→校验→解压原子步骤 |
| `skills/shot_and_vision/SKILL.md` | 截图 + 视觉证明（exec，不 invent 工具） |
| `skills/parallel_while_download/SKILL.md` | 下载等待窗口可并行筹备 |
| `tools.json` | 空数组（本轮不预置 shell 工具；经验走 skill） |
