# 内脑空转告警（已实现 P0）

> ADL：[`doc/structurizr/INNER-BURST-STALL-ALERT.md`](../structurizr/INNER-BURST-STALL-ALERT.md)

## 已实现

- `burstStallEvaluator` + `burstStallAlert`（controller 在 `failure.distill` / design 空转后触发）
- 落盘：`DATA_ROOT/stall-alerts/index.jsonl` + `stall-alerts/<instanceId>/<ts>_<id>.json`
- API：`GET /api/stall-alerts`、`GET /api/stall-alerts/:alertId`
- Dashboard Tab「空转」+ 复制 Cursor 片段

## P1 可选

- 外脑心跳读 index 自动 `post_to_im` 摘要
- `INNER_BURST_STARTED_AT` 由 spawner 注入（减少读 registry）
- 与 `web_search` 假成功修复联动后收紧阈值
