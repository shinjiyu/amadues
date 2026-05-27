/**
 * buildCompletionReport 单测:
 *   验证完成报告同时包含"做了什么"(goal/milestones) 和"做出了什么"(结果)。
 *   修复点:doc/verification-async-and-intent.md 之前用户反馈
 *         "报告了执行过程,唯独不报告结果"。
 */

import { describe, expect, it } from 'vitest';
import { buildCompletionReport, pickImSummary } from './completion-report.js';

const verbose = { audience: 'verbose' as const };
const im = { audience: 'im' as const };

describe('buildCompletionReport', () => {
  it('includes goal + milestones + knowledge + deliverables + reflexion', () => {
    const text = buildCompletionReport({
      goal: '调研 Kuroneko 项目结构',
      milestones: '- [m1] [Completed] 扫描根目录\n- [m2] [Completed] 输出报告',
      knowledge: '## 已查清\n- 项目使用 monorepo 结构\n- 主要语言:TypeScript',
      lastExecLog: null,
      reflexion: {
        verdict: 'success',
        hardFailures: [],
        softFailures: ['首次拆解略宽'],
        nextStrategy: '后续可加入 SBOM 列表',
      },
      deliverables: ['report.md', 'docs/structure.md'],
    }, verbose);
    expect(text).toContain('## 任务目标（摘要）');
    expect(text).toContain('调研 Kuroneko 项目结构');
    expect(text).toContain('## 里程碑进度');
    expect(text).toContain('## 关键结果(knowledge.md)');
    expect(text).toContain('monorepo 结构');
    expect(text).toContain('## 产出文件');
    expect(text).toContain('- report.md');
    expect(text).toContain('- docs/structure.md');
    expect(text).toContain('## 自评(reflexion)');
    expect(text).toContain('verdict: success');
    expect(text).toContain('nextStrategy: 后续可加入 SBOM 列表');
  });

  it('falls back to last executor output when knowledge is empty', () => {
    const text = buildCompletionReport({
      goal: '简单任务',
      milestones: '- [m1] [Completed] 简单步骤',
      knowledge: '',
      lastExecLog: [
        { toolName: 'shell_exec', args: {}, result: { ok: true, output: 'tool stdout' } },
        { toolName: 'write_memo', args: {}, result: { ok: true, output: '总结:任务完成,A B C 都跑了。' } },
      ],
      reflexion: null,
      deliverables: [],
    }, verbose);
    expect(text).toContain('## 核心结论');
    expect(text).toContain('A B C');
    expect(text).toContain('## 执行器末轮总结');
    expect(text).not.toContain('## 关键结果(knowledge.md)');
    expect(text).not.toContain('## 产出文件');
    expect(text).not.toContain('## 自评(reflexion)');
  });

  it('handles fully minimal inputs without throwing', () => {
    const text = buildCompletionReport({
      goal: '',
      milestones: '',
      knowledge: null,
      lastExecLog: null,
      reflexion: null,
      deliverables: [],
    }, verbose);
    expect(text).toContain('所有里程碑已完成');
    expect(text).toContain('## 里程碑进度');
    expect(text).toContain('（无）');
    expect(text).not.toContain('## 核心结论');
  });

  it('truncates very long knowledge to keep IM message readable', () => {
    const huge = '行X\n'.repeat(5000);
    const text = buildCompletionReport({
      goal: 'g',
      milestones: 'm',
      knowledge: huge,
      lastExecLog: null,
      reflexion: null,
      deliverables: [],
    }, verbose);
    expect(text.length).toBeLessThan(3500);
    expect(text).toContain('## 关键结果(knowledge.md)');
  });

  it('includes knowledge as core conclusion and still shows executor summary', () => {
    const text = buildCompletionReport({
      goal: 'g',
      milestones: 'm',
      knowledge: '关键事实写到这里',
      lastExecLog: [
        { toolName: 'echo', args: {}, result: { ok: true, output: '执行器补充一句' } },
      ],
      reflexion: null,
      deliverables: [],
    }, verbose);
    expect(text).toContain('关键事实写到这里');
    expect(text).toContain('## 执行器末轮总结');
    expect(text).toContain('执行器补充一句');
  });

  it('puts deliverable excerpt first when provided', () => {
    const text = buildCompletionReport({
      goal: 'g',
      milestones: '- [M1] [Completed] 一步',
      knowledge: null,
      lastExecLog: null,
      reflexion: null,
      deliverables: ['report.md'],
      resultExcerpt: '（摘自 `report.md`）\n\n## 结论\n完成了。',
    }, verbose);
    expect(text).toContain('## 核心结论（产物摘要）');
    expect(text.indexOf('完成了')).toBeLessThan(text.indexOf('## 里程碑进度'));
  });

  describe('audience: im', () => {
    it('prioritizes excerpt, omits milestones/goal/reflexion soft noise', () => {
      const text = buildCompletionReport(
        {
          goal: '调研 Kuroneko',
          milestones: '- [m1] [Completed] 扫描\n> 输入范围：不应出现',
          knowledge: '[事实] 冗余 knowledge',
          lastExecLog: null,
          reflexion: {
            verdict: 'success',
            hardFailures: [],
            softFailures: ['略宽'],
            nextStrategy: '下次加 SBOM',
          },
          deliverables: ['report.md'],
          resultExcerpt: '（摘自 `report.md`）\n\n## 结论\n用户 A 得分 9 分。',
        },
        im,
      );
      expect(text).toContain('## 结果');
      expect(text).toContain('用户 A 得分 9 分');
      expect(text).toContain('## 产出文件');
      expect(text).toContain('`report.md`');
      expect(text).not.toContain('里程碑');
      expect(text).not.toContain('输入范围');
      expect(text).not.toContain('略宽');
      expect(text).not.toContain('冗余 knowledge');
    });

    it('shows hardFailures only when present', () => {
      const text = buildCompletionReport(
        {
          goal: 'g',
          milestones: 'm',
          knowledge: null,
          lastExecLog: null,
          reflexion: {
            verdict: 'partial',
            hardFailures: ['产物缺失 final_report.md'],
            softFailures: [],
            nextStrategy: '',
          },
          deliverables: [],
        },
        im,
      );
      expect(text).toContain('## 需注意');
      expect(text).toContain('产物缺失');
    });

    it('pickImSummary extracts first substantive line', () => {
      const body = '## 结果\n\n完成了评估与打分。';
      expect(pickImSummary(body)).toContain('完成了评估');
    });
  });
});
