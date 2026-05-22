/**
 * 里程碑解析：`parseMilestoneLine` / `parseMilestonesFromContent` / `applyMilestoneContractLine`。
 *
 * 这是 Decomposer 输出 → controller 行动序列的唯一桥梁。
 * 任何格式松紧、契约行解析、cyclic 里程碑识别都不能跑偏。
 */
import { describe, expect, it } from 'vitest';

import {
  applyMilestoneContractLine,
  parseMilestoneLine,
  parseMilestonesFromContent,
} from './brain-fs.js';
import type { Milestone } from './brain-fs.js';

// ──────────────────────────────────────────────────────────────────────────────
// parseMilestoneLine
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMilestoneLine', () => {
  it('普通 Active 里程碑（em-dash 分隔）', () => {
    const m = parseMilestoneLine('[M1] [Active] 设置开发环境 — 安装依赖与初始化项目');
    expect(m).toEqual({
      id: 'M1',
      status: 'Active',
      title: '设置开发环境',
      description: '安装依赖与初始化项目',
    });
  });

  it('普通 Pending 里程碑（en-dash）', () => {
    const m = parseMilestoneLine('[M2] [Pending] 实现核心逻辑 – 写主流程代码');
    expect(m?.status).toBe('Pending');
    expect(m?.id).toBe('M2');
  });

  it('普通 Completed 里程碑（ASCII -）', () => {
    const m = parseMilestoneLine('[M3] [Completed] 上线 - 部署到生产');
    expect(m?.status).toBe('Completed');
  });

  it('循环里程碑：[cyclic:N] 标签解析', () => {
    const m = parseMilestoneLine('[M1] [Active] [cyclic:3600000] 每小时巡检 — 检查告警');
    expect(m).toEqual({
      id: 'M1',
      status: 'Active',
      title: '每小时巡检',
      description: '检查告警',
      cyclic: true,
      cycleIntervalMs: 3_600_000,
    });
  });

  it('循环里程碑：24h 间隔', () => {
    const m = parseMilestoneLine('[M2] [Pending] [cyclic:86400000] 每日报告 — 总结当日活动');
    expect(m?.cyclic).toBe(true);
    expect(m?.cycleIntervalMs).toBe(86_400_000);
  });

  it('缺少分隔符 → 返回 null', () => {
    expect(parseMilestoneLine('[M1] [Active] 没有分隔符的标题')).toBeNull();
  });

  it('未知 status → 返回 null', () => {
    expect(parseMilestoneLine('[M1] [Skipped] 标题 — 描述')).toBeNull();
  });

  it('完全乱来 → 返回 null', () => {
    expect(parseMilestoneLine('随便一句话')).toBeNull();
    expect(parseMilestoneLine('')).toBeNull();
  });

  it('cyclic 后跟非数字 → 不视为循环里程碑，[cyclic:abc] 被并入 title', () => {
    // 实际行为：cyclic regex 只接受 \d+；非数字时回退到普通 regex，
    // 普通 regex 把 `[cyclic:abc] 标题` 一并当作标题部分（无 cyclic 字段）。
    const m = parseMilestoneLine('[M1] [Active] [cyclic:abc] 标题 — 描述');
    expect(m).not.toBeNull();
    expect(m?.cyclic).toBeUndefined();
    expect(m?.title).toBe('[cyclic:abc] 标题');
    expect(m?.description).toBe('描述');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// applyMilestoneContractLine
// ──────────────────────────────────────────────────────────────────────────────

describe('applyMilestoneContractLine', () => {
  function blankMilestone(): Milestone {
    return { id: 'M1', status: 'Active', title: 't', description: 'd' };
  }

  it('「输入范围」标签 → inputsScope', () => {
    const m = blankMilestone();
    applyMilestoneContractLine(m, '> 输入范围：仅读 docs/');
    expect(m.inputsScope).toBe('仅读 docs/');
  });

  it('「必交付物」标签 → outputsContract', () => {
    const m = blankMilestone();
    applyMilestoneContractLine(m, '> 必交付物：生成 report.md');
    expect(m.outputsContract).toBe('生成 report.md');
  });

  it('「禁止」标签 → operationsAvoid', () => {
    const m = blankMilestone();
    applyMilestoneContractLine(m, '> 禁止：删除任何源文件');
    expect(m.operationsAvoid).toBe('删除任何源文件');
  });

  it('「前置依赖」标签 → dependsOn', () => {
    const m = blankMilestone();
    applyMilestoneContractLine(m, '> 前置依赖：M0 已完成');
    expect(m.dependsOn).toBe('M0 已完成');
  });

  it('同标签多行 → 合并保留顺序', () => {
    const m = blankMilestone();
    applyMilestoneContractLine(m, '> 输入范围：docs/');
    applyMilestoneContractLine(m, '> 输入范围：scripts/');
    expect(m.inputsScope).toBe('docs/\nscripts/');
  });

  it('全角冒号也识别', () => {
    const m = blankMilestone();
    applyMilestoneContractLine(m, '> 必交付物：生成 X');
    expect(m.outputsContract).toBe('生成 X');
  });

  it('空值 / 缺标签 → 不写入任何字段', () => {
    const m = blankMilestone();
    applyMilestoneContractLine(m, '> 必交付物：');
    applyMilestoneContractLine(m, '> 随便一段');
    expect(m.outputsContract).toBeUndefined();
    expect(m.inputsScope).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// parseMilestonesFromContent
// ──────────────────────────────────────────────────────────────────────────────

describe('parseMilestonesFromContent', () => {
  it('三条里程碑 + 契约行 → 完整结构化', () => {
    const md = `
[M1] [Active] 拉取仓库 — clone & checkout
> 前置依赖：无
> 输入范围：仅 git URL
> 必交付物：本地 worktree

[M2] [Pending] 跑 lint — 检查代码风格
> 前置依赖：M1
> 必交付物：lint 报告

[M3] [Pending] 提交 PR — 推送并开 PR
`;
    const list = parseMilestonesFromContent(md);
    expect(list.map((m) => m.id)).toEqual(['M1', 'M2', 'M3']);
    expect(list[0]).toMatchObject({
      status: 'Active',
      title: '拉取仓库',
      dependsOn: '无',
      inputsScope: '仅 git URL',
      outputsContract: '本地 worktree',
    });
    expect(list[1]).toMatchObject({ status: 'Pending', dependsOn: 'M1' });
    expect(list[2]?.dependsOn).toBeUndefined();
  });

  it('包含 cyclic + 普通里程碑混合', () => {
    const md = `
[M1] [Active] [cyclic:3600000] 巡检 — 每小时跑
[M2] [Pending] 总结 — 巡检满 100 次后产报告
`;
    const list = parseMilestonesFromContent(md);
    expect(list[0]?.cyclic).toBe(true);
    expect(list[0]?.cycleIntervalMs).toBe(3_600_000);
    expect(list[1]?.cyclic).toBeUndefined();
  });

  it('注释 # 与 // 行被忽略', () => {
    const md = `
# 这是注释
// 也是注释
[M1] [Active] 任务 — 描述
`;
    expect(parseMilestonesFromContent(md)).toHaveLength(1);
  });

  it('上下文中的 `>` 契约行没有归属里程碑 → 被丢弃', () => {
    const md = `
> 孤儿契约行
[M1] [Active] 任务 — 描述
> 必交付物：x
`;
    const list = parseMilestonesFromContent(md);
    expect(list).toHaveLength(1);
    expect(list[0]?.outputsContract).toBe('x');
  });

  it('解析失败的标题行触发 warnOnFail', () => {
    const seen: string[] = [];
    const md = `
[M1] [Active] 缺分隔符标题
[M2] [Active] 正常标题 — 描述
`;
    const list = parseMilestonesFromContent(md, (line) => seen.push(line));
    expect(list).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('缺分隔符标题');
  });

  it('完全空 / 仅注释 → 返回空数组', () => {
    expect(parseMilestonesFromContent('')).toEqual([]);
    expect(parseMilestonesFromContent('# 只有注释\n// 还有这行')).toEqual([]);
  });
});
