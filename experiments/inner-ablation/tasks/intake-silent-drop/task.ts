import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gradeFrom, type AblationTask, type GradeCheck } from '../../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

interface Row {
  file: string;
  email?: string;
  message?: string;
  reason?: string;
}

function emailProblem(email: unknown): string | null {
  if (email == null || String(email).trim() === '') return 'missing_email';
  const s = String(email).trim();
  const parts = s.split('@');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '' || /\s/.test(s)) return 'invalid_email';
  return null;
}

function classify(dir: string): { accepted: Map<string, { email: string; message: string }>; rejected: Map<string, string> } {
  const accepted = new Map<string, { email: string; message: string }>();
  const rejected = new Map<string, string>();
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
    let raw = fs.readFileSync(path.join(dir, name), 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    let obj: { email?: unknown; message?: unknown };
    try {
      obj = JSON.parse(raw) as { email?: unknown; message?: unknown };
    } catch {
      rejected.set(name, 'invalid_json');
      continue;
    }
    const emailErr = emailProblem(obj.email);
    if (emailErr) {
      rejected.set(name, emailErr);
      continue;
    }
    const message = obj.message == null ? '' : String(obj.message);
    if (message.trim() === '') {
      rejected.set(name, 'empty_message');
      continue;
    }
    if (message.length > 500) {
      rejected.set(name, 'message_too_long');
      continue;
    }
    accepted.set(name, { email: String(obj.email).trim(), message });
  }
  return { accepted, rejected };
}

function readJsonl(file: string): Row[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map(line => JSON.parse(line) as Row);
}

function matches(dir: string, workDir: string): string | null {
  const want = classify(dir);
  const accepted = readJsonl(path.join(workDir, 'out', 'accepted.jsonl'));
  const rejected = readJsonl(path.join(workDir, 'out', 'rejections.jsonl'));
  const seen = new Set<string>();
  if (accepted.length !== want.accepted.size) return `accepted ${accepted.length}!=${want.accepted.size}`;
  for (const row of accepted) {
    if (seen.has(row.file)) return `dup ${row.file}`;
    seen.add(row.file);
    const exp = want.accepted.get(row.file);
    if (!exp || row.email !== exp.email || row.message !== exp.message) return `accepted ${row.file}`;
  }
  if (rejected.length !== want.rejected.size) return `rejected ${rejected.length}!=${want.rejected.size}`;
  for (const row of rejected) {
    if (seen.has(row.file)) return `dup ${row.file}`;
    seen.add(row.file);
    if (want.rejected.get(row.file) !== row.reason) return `rejected ${row.file}`;
  }
  const names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
  if (seen.size !== names.length) return 'not every file has one outcome';
  return null;
}

function runIntake(workDir: string): string | null {
  const run = spawnSync(process.execPath, [path.join(workDir, 'src', 'intake.cjs')], {
    cwd: workDir,
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (run.status !== 0) return (run.stderr || run.stdout || 'exit').slice(0, 200);
  return null;
}

export const intakeSilentDrop: AblationTask = {
  id: 'intake-silent-drop',
  source: {
    instanceIds: [],
    summary: '第三轮开放排查：有的提交没进收件箱，笔记说那些本来就该丢',
  },
  fixtureDir: path.join(here, 'fixture'),
  referenceDir: path.join(here, 'reference'),
  protectedFiles: [
    'incoming/ok.json',
    'incoming/plus.json',
    'incoming/bom.json',
    'incoming/no-email.json',
    'incoming/empty.json',
    'incoming/long.json',
    'incoming/exact.json',
  ],

  goal: () =>
    [
      '【有的提交不见了】用户说表交了，后台列表里没有。incoming/ 里每个 json 文件都是一份提交，请查清谁被丢掉了，并修好 src/intake.cjs。',
      '规则：',
      '1. 每个文件恰好出现一次：要么在 out/accepted.jsonl，要么在 out/rejections.jsonl。不能悄悄跳过。',
      '2. 文件可以带 UTF-8 BOM。去掉 BOM 之后能解析成 JSON 对象的，不要当成 invalid_json。',
      '3. 邮箱去掉两端空白后，必须含且只含一个 @，左右都非空，且不含空白。本地部分允许加号。缺邮箱用 missing_email，格式不对用 invalid_email。',
      '4. message 去掉两端空白后不能为空（empty_message）；原始 length 超过 500 用 message_too_long。',
      '5. 收下的行是 {"file","email","message"}，email 用去掉空白后的值。拒绝的行是 {"file","reason"}。',
      '在工作目录执行 `node src/intake.cjs` 生成这两个文件。incoming 里的原件不能改。评测会再放一份合法提交重跑。',
      '工作目录里已有一份约定笔记，只是前人留下的，对错你自己判断。',
    ].join('\n'),

  async grade(workDir) {
    const checks: GradeCheck[] = [];
    const dir = path.join(workDir, 'incoming');
    const base = classify(dir);
    const sane = base.accepted.size === 4 && base.rejected.size === 3
      && base.accepted.has('plus.json') && base.accepted.has('bom.json')
      && base.rejected.get('long.json') === 'message_too_long';
    checks.push({ name: 'grader_fixture_sane', ok: sane, detail: `${base.accepted.size}/${base.rejected.size}` });
    if (!sane) return gradeFrom(checks);

    const firstErr = runIntake(workDir);
    const first = firstErr ?? matches(dir, workDir);
    checks.push({ name: 'every_file_classified', ok: first == null, detail: first ?? 'ok' });

    const extra = path.join(dir, 'grade-extra.json');
    try {
      fs.writeFileSync(extra, JSON.stringify({ email: 'a+b@ex.com', message: 'extra' }));
      const secondErr = runIntake(workDir);
      const second = secondErr ?? matches(dir, workDir);
      checks.push({ name: 'recomputes_new_file', ok: second == null, detail: second ?? 'ok' });
    } finally {
      fs.rmSync(extra, { force: true });
    }
    return gradeFrom(checks);
  },
};
