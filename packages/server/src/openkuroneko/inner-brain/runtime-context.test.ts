import { describe, expect, it } from 'vitest';

import { buildRuntimeContextSection } from './runtime-context.js';

describe('buildRuntimeContextSection', () => {
  it('includes platform, workDir, vault path, and credential rules', () => {
    const block = buildRuntimeContextSection({
      workDir: '/tmp/ws',
      dataRoot: '/data/agent',
    });
    expect(block).toContain('## 运行时环境');
    expect(block).toContain('platform:');
    expect(block).toContain('workDir: /tmp/ws');
    expect(block).toContain('vault/blocks/keychain');
    expect(block).toContain('data/agent');
    expect(block).toContain('instruction');
    expect(block).toContain('明文');
    expect(block).toContain('禁止');
    expect(block).not.toContain('UTLRA_DATA_ROOT 未设置');
  });

  it('notes missing dataRoot', () => {
    const prev = process.env['UTLRA_DATA_ROOT'];
    delete process.env['UTLRA_DATA_ROOT'];
    try {
      const block = buildRuntimeContextSection({ workDir: '/w' });
      expect(block).toContain('vault 不可用');
    } finally {
      if (prev !== undefined) process.env['UTLRA_DATA_ROOT'] = prev;
    }
  });
});
