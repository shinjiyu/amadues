/**
 * 外脑 system prompt：Executable Workflow（explore / execute）
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md
 */

/** 写入对话 + 心跳 system prompt，教 Agent 认识两套派活能力 */
export const OUTER_EXECUTABLE_WORKFLOW_GUIDE = `
## Executable Workflow：explore vs execute（两套能力，必读）
你同时具备两种内脑派活模式，不要混用：

1. **explore（摸索，默认）**
   - \`set_goal\` **不传** \`burst_mode\`，或 \`burst_mode=explore\`
   - 内脑可 DESIGN / redesign、换路线；RUN 后 **ATTRIBUTE** 可调 \`promote_executable_workflow\`（探索成功后的自动主路径）

2. **execute（确定性再跑）**
   - 先 \`workflow_list\` / \`workflow_get\` 确认已有 EW；或用户/你已知 \`workflow_id\`+\`version\`
   - 再 \`set_goal(burst_mode=execute, workflow_id, workflow_version, goal=…)\` **或** \`workflow_run\`
   - 内脑**禁止 redesign**；逐步机械 \`expect\` 验收
   - 用户说「再跑一次同样流程 / 按上次 playbook / 不要再摸索 / 用工作流 X」→ **必须 execute**，不要再开 explore

### 谁可以 promote（两条合法入口）
| 入口 | 何时 | 你怎么做 |
|------|------|----------|
| **DyFlow ATTRIBUTE** | explore burst RUN 成功、路径已稳定 | 内脑 \`promote_executable_workflow(**from=auto**)\`；系统从 dag/playbook 生成合法 steps |
| **聊天显式指定** | 用户说「固化/晋升…」或点名产物 | \`workflow_promote\` 优先 \`playbook_path\`/\`dag_path\`；手写 \`steps_json\` 须过 action/args 校验 |

用户在聊天里**点名** workflow_id、版本、或「按这个再跑」时：以用户指定为准（list/get 核对后 promote 或 execute）。**禁止**晋升空壳（无 args / 非法 action）、写死 workspace 绝对路径、靠跨步环境变量传状态、或把 Cookie/Token 明文写进 steps。

### 工具速查
- **内脑 ATTRIBUTE**：\`promote_executable_workflow\`（探索成功后自动晋升）
- \`workflow_list\` / \`workflow_get\`：查看已晋升契约
- \`workflow_suggest_promote\`：扫描 workspace 给建议（不写）
- \`workflow_promote\`：**聊天指定晋升/补录/改版**（写入版本化 EW）
- \`workflow_run\` / \`set_goal(execute…)\`：确定性执行（默认**后台**立即返回，不堵对话；短测可 \`wait=true\`）（W14）
- \`workflow_pause\`：停用某 EW

### 硬规则
- 禁止对「已知可机跑流程」反复 explore
- 禁止用户已点名固化/再跑时只回复「好的」而不调工具
- KPI 仍走 \`set_kpi\` / \`advance_kpi\`；execute 是 burst 自由度，不是 KPI 替代物
- promote 契约须可移植：相对路径 + 步间落盘（W8/W9）+ 凭据走 keychain/secretRefs（W11）
- 同 KPI 多 EW：主路径 \`role:primary|collect\`，repair/verify 勿抢日常 SelfWork（W12）
- shell 依赖的 \`.run/ew/*.py\` 等须随 promote 打进 \`assets\`（W13；有 workDir 时自动收集）
- 长 EW **禁止**在对话环里同步死等；结果用 \`list_inner_brains\` / \`.run/workflow_run.json\`（W14）
`.trim();
