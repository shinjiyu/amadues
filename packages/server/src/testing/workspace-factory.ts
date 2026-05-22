/**
 * 构造最小内脑工作区（不启动子进程）— 模拟 controller 落盘后的磁盘状态。
 */
import fs from 'node:fs';
import path from 'node:path';

import { POST_COMPLETE_REASON } from '../outer/brain-async-snapshot.js';

export interface SyntheticWorkspaceOpts {
  goal?: string;
  deliverables?: string[];
  reflexion?: {
    verdict: 'success' | 'partial' | 'failed';
    hardFailures?: string[];
    nextStrategy?: string;
  };
  postComplete?: boolean;
  asyncWaiting?: boolean;
  blockedReason?: string;
}

export function writeSyntheticWorkspace(
  workDir: string,
  opts: SyntheticWorkspaceOpts = {},
): void {
  const brain = path.join(workDir, '.brain');
  const run = path.join(workDir, '.run', 'pi-mono');
  fs.mkdirSync(brain, { recursive: true });
  fs.mkdirSync(run, { recursive: true });

  fs.writeFileSync(
    path.join(brain, 'goal.md'),
    opts.goal ?? '测试目标',
    'utf8',
  );
  fs.writeFileSync(
    path.join(brain, 'milestones.md'),
    '[M1] [Completed] 完成主交付\n',
    'utf8',
  );

  const deliverables = opts.deliverables ?? [];
  if (deliverables.length > 0) {
    fs.writeFileSync(path.join(run, 'deliverables.json'), JSON.stringify(deliverables), 'utf8');
    for (const rel of deliverables) {
      const abs = path.join(workDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (!fs.existsSync(abs)) {
        fs.writeFileSync(abs, `# ${rel}\n\n## 结论\n测试产出正文。\n`, 'utf8');
      }
    }
  }

  const verdict = opts.reflexion?.verdict ?? 'success';
  fs.writeFileSync(
    path.join(brain, 'reflexion.json'),
    JSON.stringify({
      verdict,
      hardFailures: opts.reflexion?.hardFailures ?? (verdict === 'failed' ? ['模拟失败'] : []),
      softFailures: [],
      nextStrategy: opts.reflexion?.nextStrategy ?? '',
    }),
    'utf8',
  );

  fs.writeFileSync(
    path.join(brain, 'knowledge.md'),
    '[事实] 测试 knowledge 条目\n',
    'utf8',
  );

  if (opts.postComplete) {
    fs.writeFileSync(
      path.join(brain, 'controller-state.json'),
      JSON.stringify({
        mode: 'BLOCKED',
        blockedReason: POST_COMPLETE_REASON,
        awaitingReason: null,
      }),
      'utf8',
    );
  } else if (opts.asyncWaiting) {
    fs.writeFileSync(
      path.join(brain, 'controller-state.json'),
      JSON.stringify({ mode: 'AWAITING', awaitingReason: '等外部' }),
      'utf8',
    );
  } else if (opts.blockedReason) {
    fs.writeFileSync(
      path.join(brain, 'controller-state.json'),
      JSON.stringify({ mode: 'BLOCKED', blockedReason: opts.blockedReason }),
      'utf8',
    );
  }
}
