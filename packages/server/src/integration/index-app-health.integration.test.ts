/**
 * F 装配：index 模块 health（UTLRA_SKIP_AGENT_BOOTSTRAP=1，不 listen）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('integration: index app health (no listen)', () => {
  let dataRoot: string;
  const prevSkip = process.env['UTLRA_SKIP_AGENT_BOOTSTRAP'];
  const prevDataRoot = process.env['UTLRA_DATA_ROOT'];

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'index-app-health-'));
    process.env['UTLRA_SKIP_AGENT_BOOTSTRAP'] = '1';
    process.env['UTLRA_DATA_ROOT'] = dataRoot;
  });

  afterEach(() => {
    if (prevSkip === undefined) delete process.env['UTLRA_SKIP_AGENT_BOOTSTRAP'];
    else process.env['UTLRA_SKIP_AGENT_BOOTSTRAP'] = prevSkip;
    if (prevDataRoot === undefined) delete process.env['UTLRA_DATA_ROOT'];
    else process.env['UTLRA_DATA_ROOT'] = prevDataRoot;
    try {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('GET /api/health 与导出 DATA_ROOT 一致', async () => {
    const mod = await import('../index.js');
    const res = await mod.app.request('http://test/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dataRoot: string };
    expect(body.ok).toBe(true);
    expect(body.dataRoot).toBe(mod.DATA_ROOT);
    expect(fs.existsSync(mod.DATA_ROOT)).toBe(true);
  });
});
