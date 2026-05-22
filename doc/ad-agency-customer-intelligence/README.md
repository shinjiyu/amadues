# 广告公司 · 目标客户智能系统（讨论区）

> **状态**：需求讨论 / 方案草案，**非** Kuroneko 主仓实现范围  
> **版本**：v0.3（**编排层：工作流 / Agent**，业务不直连 LLM API）  
> **入口**：[需求规格](./requirements.md) · [架构与数据流草案](./architecture-draft.md) · [开放问题清单](./open-questions.md)  
> **落地技术方案**：[工作流 vs Agent 选型](./tech/05-workflow-vs-agent.md) · [AI 零知识总纲](./tech/04-ai-zero-knowledge.md) · [共享平台](./tech/00-platform.md) · [需求一](./tech/01-intelligence-collection.md) · [需求二](./tech/02-roi-scoring-and-ranking.md) · [需求三](./tech/03-proposal-generation.md)

---

## 背景（一句话）

朋友所在广告公司有两块已有资产：**内部广告案例库（有数据源）** 与 **目标客户名单**；希望建一套 **AI 驱动** 的系统，完成「客户情报收集 → 按 ROI 筛选排序 → 头部客户营销方案生成」的闭环。

**客户强调**：尽量 **零知识启动**——例如情报收集希望 **AI 自行探索公网/可用信息源**，而非先接好 CRM、工商 API、字段映射才能跑。

---

## 三大能力（与业务诉求对齐）

| # | 能力 | 产出物 |
|---|------|--------|
| 1 | **目标客户信息收集** | 可检索、可更新的客户档案（历史合作方、投放数据、行业标签等） |
| 2 | **案例驱动的客户筛选** | 按预估/历史 ROI 排序的候选列表与筛选理由 |
| 3 | **头部客户方案设计** | 针对排序靠前客户的广告营销方案草案（可人工润色） |

---

## 文档索引

| 文档 | 内容 |
|------|------|
| [requirements.md](./requirements.md) | 功能/非功能需求、数据实体、ROI 口径、分期 |
| [architecture-draft.md](./architecture-draft.md) | 模块划分、数据流、与 AI/人工边界 |
| [open-questions.md](./open-questions.md) | 需向业务方确认的问题（数据源、合规、ROI 定义等） |
| [tech/00-platform.md](./tech/00-platform.md) | 共用技术栈、库表、鉴权、分期总表 |
| [tech/01-intelligence-collection.md](./tech/01-intelligence-collection.md) | 需求一：导入、enrichment、审核、案例 ETL |
| [tech/02-roi-scoring-and-ranking.md](./tech/02-roi-scoring-and-ranking.md) | 需求二：相似案例、ROI 引擎、榜单 API |
| [tech/03-proposal-generation.md](./tech/03-proposal-generation.md) | 需求三：RAG、JSON Schema、编辑导出 |
| [tech/04-ai-zero-knowledge.md](./tech/04-ai-zero-knowledge.md) | 零知识启动、信源自发现 |
| [tech/05-workflow-vs-agent.md](./tech/05-workflow-vs-agent.md) | **分项用工作流还是 Agent、Dify/n8n 选型** |
| [tech/workflows-detailed-design.md](./tech/workflows-detailed-design.md) | **三个工作流节点级设计、内部 API、Prompt Schema** |

---

## 架构示意图

**编排分层（业务不直连大模型接口）**

![广告公司客户智能系统 - 编排架构说明](./assets/ad-intel-orchestration-architecture.png)

**智能体与工作流分工说明**

![智能体与工作流分工说明](./assets/ad-intel-workflow-vs-agent.png)

**三个核心工作流端到端串联**

![三个核心工作流 - 端到端串联说明](./assets/ad-intel-three-workflows-pipeline.png)

详见 [tech/workflows-detailed-design.md](./tech/workflows-detailed-design.md)。

---

## 编排原则（一句话）

- **业务系统**：只调 **Dify Agent / Workflow**（或 n8n 批处理），**不直连** 大模型 API。  
- **仅需求一「公网探索」用 Agent**；打分、方案、校验、单页抽取均为 **工作流**。  
- PoC 推荐：**Dify 自建** + `tools-service`（搜索/抓取/写库）。

## AI 零知识启动（一句话）

上传 **一列公司名** → **Dify Agent** 探索信源 → **工作流** 校验入库 → **工作流** 打分 → **工作流** 生成方案；案例库/CRM 接入后只 **加速**。

---

## 建议的下一步（讨论用）

1. 对照 [open-questions.md §G](./open-questions.md) 确认 **公网调研范围、审核策略、搜索 API 预算**。  
2. PoC 以 [04-ai-zero-knowledge.md](./tech/04-ai-zero-knowledge.md) 的 P0 为准（探索 + 审核），案例 ETL 并行但不挡启动。  
3. 再决定是否独立仓库，或复用 Kuroneko Agent / Tool 协议做 PoC。
