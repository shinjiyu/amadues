/**
 * staged 探针的机械合同（ADL: TOOL-MDL-GROWTH.md §11.22）
 *
 * 一条 shell 最多改动一个阶段文件，且必须按 s1 → s2 → out.csv 的顺序。
 * 违规回滚。这是实验执行器上的约束，不进冻结内核，也不扩张 A_prim。
 */
import fs from 'node:fs';
import path from 'node:path';

export const STAGE_FILES = ['work/s1.txt', 'work/s2.txt', 'out.csv'] as const;

export type StageFile = (typeof STAGE_FILES)[number];

export interface StageSnapshot {
  files: Record<StageFile, string | null>;
}

export function captureStages(workDir: string): StageSnapshot {
  const files = {} as StageSnapshot['files'];
  for (const rel of STAGE_FILES) {
    const abs = path.join(workDir, rel);
    files[rel] = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  }
  return { files };
}

function changed(before: StageSnapshot, after: StageSnapshot): StageFile[] {
  return STAGE_FILES.filter(rel => before.files[rel] !== after.files[rel]);
}

/** 返回拒绝原因；无违规则 null。不改磁盘。 */
export function stageViolation(before: StageSnapshot, after: StageSnapshot): string | null {
  const delta = changed(before, after);
  if (delta.length > 1) {
    return 'rejected: one command changed more than one of work/s1.txt, work/s2.txt, out.csv; rolled back';
  }
  if (delta.length === 0) return null;
  const file = delta[0];
  if (file === 'work/s2.txt' && before.files['work/s1.txt'] === null) {
    return 'rejected: work/s2.txt before work/s1.txt exists; rolled back';
  }
  if (
    file === 'out.csv' &&
    (before.files['work/s1.txt'] === null || before.files['work/s2.txt'] === null)
  ) {
    return 'rejected: out.csv before both work/s1.txt and work/s2.txt exist; rolled back';
  }
  return null;
}

export function restoreStages(workDir: string, before: StageSnapshot): void {
  for (const rel of STAGE_FILES) {
    const abs = path.join(workDir, rel);
    const prev = before.files[rel];
    if (prev === null) fs.rmSync(abs, { force: true });
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, prev, 'utf8');
    }
  }
}

export function enforceStageGate(
  workDir: string,
  before: StageSnapshot,
): { ok: true } | { ok: false; observation: string } {
  const msg = stageViolation(before, captureStages(workDir));
  if (!msg) return { ok: true };
  restoreStages(workDir, before);
  return { ok: false, observation: msg };
}
