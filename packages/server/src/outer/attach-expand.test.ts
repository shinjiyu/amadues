/**
 * 单元测试：attach_asset_ids 运行时展开器
 *
 * 守住 doc/protocols/inner-brain-deliverables.md 的关键契约：
 * - R6.4 / R6.5：未知 id 静默剔除，不阻断
 * - R6.6：`asset:` 前缀容忍（自动 strip）
 * - R8.1：rejected 写入 deliverables.log
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatAssetStore } from '@utlra/chat-ir';
import { expandAttachAssetIds, stripAssetPrefix } from './attach-expand.js';

function makeTmp(): { logDir: string; assetStore: ChatAssetStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kuroneko-attach-'));
  const logDir = path.join(root, 'workspace');
  fs.mkdirSync(logDir, { recursive: true });
  return { logDir, assetStore: new ChatAssetStore(path.join(root, 'uploads')) };
}

function readLog(logDir: string): Array<Record<string, unknown>> {
  const f = path.join(logDir, '.run', 'deliverables.log');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('stripAssetPrefix', () => {
  it('保留裸 UUID 原样', () => {
    expect(stripAssetPrefix('a1b2c3')).toBe('a1b2c3');
  });
  it('strip `asset:` 前缀', () => {
    expect(stripAssetPrefix('asset:a1b2c3')).toBe('a1b2c3');
  });
  it('trim 前后空白', () => {
    expect(stripAssetPrefix('  asset:abc  ')).toBe('abc');
  });
});

describe('expandAttachAssetIds', () => {
  let tmp: ReturnType<typeof makeTmp>;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => { fs.rmSync(path.dirname(tmp.logDir), { recursive: true, force: true }); });

  it('空输入返回空结果', () => {
    const r = expandAttachAssetIds(undefined, tmp.assetStore);
    expect(r.parts).toHaveLength(0);
    expect(r.rejected).toHaveLength(0);
    expect(r.resolvedIds).toHaveLength(0);
  });

  it('展开已知 asset → attachment part', () => {
    const meta = tmp.assetStore.save(Buffer.from('hello'), 'text/markdown', 'a.md');
    const r = expandAttachAssetIds([meta.id], tmp.assetStore);

    expect(r.parts).toHaveLength(1);
    const p = r.parts[0]!;
    expect(p.type).toBe('attachment');
    expect(p.asset_ref.uri).toBe(`asset:${meta.id}`);
    expect(p.asset_ref.mime).toBe('text/markdown');
    expect(p.asset_ref.name).toBe('a.md');
    expect(p.asset_ref.kind).toBe('file');
    expect(r.resolvedIds).toEqual([meta.id]);
    expect(r.rejected).toHaveLength(0);
  });

  it('R6.6：自动 strip `asset:` 前缀', () => {
    const meta = tmp.assetStore.save(Buffer.from('x'), 'image/png', 'shot.png');
    const r = expandAttachAssetIds([`asset:${meta.id}`], tmp.assetStore);
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]!.asset_ref.kind).toBe('image');
  });

  it('R6.5：未知 id 静默剔除（不抛异常）+ 写 log', () => {
    const meta = tmp.assetStore.save(Buffer.from('x'), 'text/plain', 'ok.txt');
    const r = expandAttachAssetIds(
      [meta.id, '00000000-0000-0000-0000-000000000000', 'not-a-uuid'],
      tmp.assetStore,
      { logDir: tmp.logDir },
    );

    expect(r.parts).toHaveLength(1);
    expect(r.resolvedIds).toEqual([meta.id]);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected.map((x) => x.id).sort()).toEqual(
      ['00000000-0000-0000-0000-000000000000', 'not-a-uuid'].sort(),
    );

    const log = readLog(tmp.logDir);
    expect(log.filter((l) => l.event === 'attach_reject')).toHaveLength(2);
  });

  it('多个合法 id：parts 顺序与输入一致', () => {
    const a = tmp.assetStore.save(Buffer.from('a'), 'text/plain', 'A.txt');
    const b = tmp.assetStore.save(Buffer.from('b'), 'image/png',  'B.png');
    const r = expandAttachAssetIds([b.id, a.id], tmp.assetStore);
    expect(r.parts.map((p) => p.asset_ref.name)).toEqual(['B.png', 'A.txt']);
  });

  it('空字符串 id 被剔除', () => {
    const r = expandAttachAssetIds(['', '  ', 'asset:'], tmp.assetStore);
    expect(r.parts).toHaveLength(0);
    expect(r.rejected.length).toBeGreaterThan(0);
  });
});
