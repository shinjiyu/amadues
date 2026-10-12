# 自主主体层

> **状态**：**ADL 待评审**（未实现）
>
> **权威设计**：[`doc/structurizr/SUBJECT-CORE.md`](../structurizr/SUBJECT-CORE.md)

讨论与契约以 Structurizr 专篇为准。本文只在待办索引里占一行，避免第二份设计。

2026-10-12 主人裁定：所有人类消息，包括主人自己的 sid，都只是信号。`no_reply`、`defer`、`decline` 对主人 sid 不得例外（专篇 SC-10）。

其余产品常数已在专篇 §17 关闭（驱动力、冷却、不新建 KPI、回复文本、participation 前门、defer 间隔、think-log）。实现时不要再留待定项。

旗标 `UTLRA_SUBJECT_CORE_ENABLED` 默认关。P0–P3 与测试表见专篇 §14。实现前不要改 `outer-conversation-loop.ts` 的强制回复行为。
