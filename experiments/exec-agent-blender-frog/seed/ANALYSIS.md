# 本轮事后分析 → 下一轮种子

## A. Agent 首轮（exec-agent blender-frog）

来源：blender-frog complete · wall **7.5m** · exec×18 · fail×4 · stop=complete

### 时间切分

| 段 | 约 | 评价 |
|----|----|------|
| health → bpy 建蛙 → 导出 frog.glb → 写 index.html | **~1.0m** | 种子 `blender_bridge` 有效，几乎不浪费 |
| 找浏览器 / Safari+selenium / 装 playwright / ETIMEDOUT | **~5.5m** | **主浪费**；`shot_and_vision` 太泛，先走死路径 |
| 调光 + PIL 采样 + vision-proof | **~1.0m** | 正常 |

act ~5.9m / reflect ~1.6m。Reflect 现场补了 `browser_screenshot_playwright`、`avoid_hanging_exec` 等——应固化进 seed，别每轮再探索。

### 可规避失败（agent）

1. `which google-chrome` / Applications 无 Chrome → fail（本机只有 Playwright/Steam 路径）
2. Safari + selenium：截图未落到 `reports/`（cwd/权限）
3. `npx playwright` + 首跑 shot → **ETIMEDOUT**（120s exec 上限）
4. 曾把 `echo done` 拼进 `index.html` 末尾（heredoc/壳污染）

### 本目录更新（agent 轮）

| 类型 | 条目 | 作用 |
|------|------|------|
| rule | `prefer_playwright_chromium` | 禁止优先 Safari/selenium；先 ms-playwright 缓存 |
| rule | `no_foreground_browser_install` | 装 chromium 必须短命令或已缓存；忌超长前台 |
| rule | `heredoc_html_clean` | index.html heredoc 后不要再 echo |
| skill | `shot_and_vision` | 重写为本机可走通的 Playwright 路径 |
| skill | `blender_bridge` | 补充「脚本文件 + JSON 读入」大段 bpy |
| tools.json | `bridge_health` / `bridge_exec` | 截图仍走 skill（Playwright 路径因本机而异，不适硬编码成单工具） |

---

## B. Cursor + Blender MCP 精细蛙（v3）

来源：人工通过 `blender_exec` 跑 `work/frog_v3.py` · Skin 骨架 → 程序化材质 → bake → H5。

### 流程（成功路径）

```
health
  → step_mesh (Skin + fill_holes + voxel remesh + warts + UV)
  → step_eyes
  → step_material (procedural lookdev)
  → step_stage + multi-angle Eevee stills  ← 视觉闸门
  → step_bake (EMIT color/rough + NORMAL) ← glTF 必经
  → step_export GLB (pack images)
  → index.html cache-bust + front camera (−Z)
  → browser screenshot
```

### 可规避失败（建模质量）

| 现象 | 根因 | 固化 |
|------|------|------|
| 只剩脚趾 / 漂浮眼球，躯干消失 | Skin 开洞后直接 Voxel Remesh | rule `remesh_closed_mesh` |
| Blender 好看、H5 全白 | 程序化节点未 bake 进贴图 | rule `gltf_requires_bake` + skill `bake_procedural_for_gltf` |
| 背斑几乎看不见 | Voronoi Distance Map Range 过紧 | skill `lookdev_render_loop`（Emission 调试） |
| 单次 `/exec` 超时 | mesh+bake+export 捆在一起 | rule `split_blender_steps` |
| H5 只看到尾巴朝向 | Blender +Y → glTF −Z，相机仍在 +Z | `fine_organic_model` §6 |
| Metaball / 单球堆 = 「玩具塑料」 | 无肢骨半径 / 无分层材质 / 无 lookdev 闸门 | skill `fine_organic_model` |

### 本目录更新（v3 轮）

| 类型 | 条目 | 作用 |
|------|------|------|
| skill | `fine_organic_model` | **主技能**：精细有机体 Skin→lookdev→bake→H5 全流程 |
| skill | `bake_procedural_for_gltf` | 程序化材质 EMIT/NORMAL bake 与重接 |
| skill | `lookdev_render_loop` | 多角度静帧拒收表与单子系统迭代 |
| skill | `film_frog_materials` | 改为短清单，指向上述技能 |
| skill | `blender_bridge` | 强调分步 + 精细模型入口 |
| rule | `remesh_closed_mesh` | remesh 前必须闭壳 |
| rule | `gltf_requires_bake` | 导出前强制 bake |
| rule | `split_blender_steps` | 一步一 `/exec` |

### 仍未达标（下轮可续写 skill）

- 虹膜仍是单色球，缺纹理 / 角膜层
- 趾无蹼、趾垫弱
- 后腿偏圆鼓，缺肌肉转折

若下轮要「电影级」，在 `fine_organic_model` 上追加：iris texture、toe webbing sculpt、thigh volume controls。

---

## C. Skill → 题干 → mini agent 复测（2026-09-23）

- 题干改为强制 `fine_organic_model` 流水线；规则 `no_copy_prior_builds`。
- Cursor 产物迁出 `work/` → `saved/v3`、`saved/v4`（避免 `place()` wipe）。
- 硬门增加 GLB ≥ ~800KB（防未 bake 空壳）。
- 跑：`npx --yes tsx …/run-blender-frog.ts` · wall **~46m** · exec≈102 · bridge_exec×39 · fail×3
- 种子开局 skill×6 / rule×10；reflect 又长出 skill/rule（终局 skill×13 / rule×20）
- 产物：`work/build_frog.py`（自写 Skin+fill_holes+bake，**未**拷 `saved/`）· `frog.glb` 1.66MB（images×3）· `index.html` · lookdev 三静帧 · `reports/scene.png` · vision-proof / design
- 文件硬门：**PASS**（glb / light / vision-proof cue / ≥800KB）
- **视觉：FAIL** — lookdev/H5 仍是「双眼球 + 碎屑」，典型 **开壳 remesh 吃掉躯干**；vision-proof 文字偏乐观，与 `scene.png` 不符
- 停因：产物齐后 **JEV HTTP 403**，未拿到正式 `stop=complete` / 未打印 hard-gate 行
- 归档：`saved/agent-fine-1/`（含当时 `.agent` reflect 增量）

### 本轮对 seed 的启示

1. `remesh_closed_mesh` 已被引用但仍翻车 → lookdev 闸门要加强：**躯干像素占比 / bbox 体积** 不够则禁止 bake
2. vision-proof 需绑定截图事实，或硬门加 PIL「连通主块」检查
3. JEV 403 要单独修密钥/配额，否则无法正式 complete

---

## D. v3 思维链 → skill → Grok 对照

- Skill：`seed/skills/skin_frog_cot/SKILL.md`（v3 写脚本前 CoT + fill_holes/bake 硬教训）
- 隔离试跑：`experiments/exec-agent-blender-frog/grok-cot-test/`（禁读 saved/v3 源码）
- Subagent：Grok 4.7 · **完成**
  - 脚本 `work/build_frog_cot.py`；mesh **17438 / 17440**；GLB **~2.5MB**（images 有 bake）
  - 静帧 `reports/front34.png` 等；报告 `work/REPORT.md`
  - 遵守：Skin 骨架、闭壳再 remesh、FINAL_* bake
  - 弱于 v3：眼更「凸」、斑更淡、趾简、面数/贴图分辨率低于 v3（~49k / 10.8MB）
  - 摩擦：bpy 5.2 `calc_normals_split` 缺失；整段 bake 曾 MCP 超时（烤图仍落盘）

### 跟进：题材换成滑稽动漫角色

- 用户反馈 Grok 蛙「不像青蛙」→ skill `chibi_anime_cot`（滑稽丸）
- 试跑：`grok-chibi-test/` · [Grok chibi anime test](9a08c6cf-723c-42a2-baba-58c84b8218c6) · **完成**
  - `chibi.glb` ~457KB · ~7.8k verts · stills 一眼可读为 Q 版动漫角色（大头/大眼/咧嘴/啊哈毛）
  - 弱项：肤色发白、眉条易看成「胡子」、躯干偏方块
