import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCjs } from '../../lib/load-cjs.ts';
import { gradeFrom, type AblationTask, type GradeCheck } from '../../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

function expectedRedact(line: string): string {
  return line
    .replace(/\b(token|api_key|password)=([^&\s]+)/g, '$1=[redacted]')
    .replace(/(Authorization:\s*Bearer\s+)\S+/g, '$1[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
}

const EXTRA: readonly string[] = [
  'see ADA@EX.com.',
  'token=abc',
  'Authorization: Bearer   tok',
  'nothing to do',
  'a@b.co token=zzz',
  'password=a,b&next=1',
  'token=ada@ex.com&ok=1',
];

interface RedactApi {
  redactLine(line: string): string;
}

export const accessLogRedact: AblationTask = {
  id: 'access-log-redact',
  source: {
    instanceIds: [],
    summary: '第二轮自建：访问日志只抹了邮箱，查询参数和 Bearer 令牌还在',
  },
  fixtureDir: path.join(here, 'fixture'),
  referenceDir: path.join(here, 'reference'),
  protectedFiles: ['data/access.log'],

  goal: () =>
    [
      '【日志脱敏】修好 lib/redact.cjs 导出的 redactLine(line)，规则如下，对任意一行都成立：',
      '1. 先处理查询参数 token、api_key、password：保留参数名和等号，值换成 [redacted]。值一直取到 & 或空白为止，中间的逗号算在值里。',
      '2. 再处理请求头。形如 Authorization: Bearer <token> 时，保留 "Authorization: Bearer " 这一段里的空白原样，token 换成 [redacted]。',
      '3. 最后把剩下的电子邮箱换成 [email]。已经按上面两条脱敏的值不要再当成邮箱。',
      '4. 其它字符原样保留。',
      '然后在工作目录运行 `node lib/redact.cjs`，把 data/access.log 逐行脱敏写到 out/clean.log。',
      'data/access.log 严禁修改。评测会用文件以外的行调用 redactLine，并删掉现有 out/clean.log 后重新运行脚本。',
    ].join('\n'),

  async grade(workDir) {
    const checks: GradeCheck[] = [];
    let api: RedactApi;
    try {
      api = loadCjs<RedactApi>(path.join(workDir, 'lib', 'redact.cjs'));
    } catch (e) {
      checks.push({ name: 'redact_loads', ok: false, detail: String(e) });
      return gradeFrom(checks);
    }
    checks.push({ name: 'redact_loads', ok: typeof api.redactLine === 'function' });
    if (typeof api.redactLine !== 'function') return gradeFrom(checks);

    let specOk = 0;
    for (const line of EXTRA) {
      try {
        if (api.redactLine(line) === expectedRedact(line)) specOk += 1;
      } catch { /* count as miss */ }
    }
    checks.push({ name: 'spec_lines', ok: specOk === EXTRA.length, detail: `${specOk}/${EXTRA.length}` });

    const logPath = path.join(workDir, 'data', 'access.log');
    const raw = fs.readFileSync(logPath, 'utf8');
    const want = raw.split('\n').map(line => expectedRedact(line)).join('\n');
    const outFile = path.join(workDir, 'out', 'clean.log');
    fs.rmSync(outFile, { force: true });
    const run = spawnSync(process.execPath, [path.join(workDir, 'lib', 'redact.cjs')], {
      cwd: workDir,
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (run.status !== 0) {
      checks.push({ name: 'script_exits_0', ok: false, detail: (run.stderr || run.stdout || '').slice(0, 200) });
      return gradeFrom(checks);
    }
    checks.push({ name: 'script_exits_0', ok: true });
    const got = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
    checks.push({ name: 'clean_log_matches', ok: got === want, detail: got === want ? 'ok' : got.slice(0, 180) });
    return gradeFrom(checks);
  },
};
