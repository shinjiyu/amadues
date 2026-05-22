/**
 * 单元测试：内脑产物 → asset 吸收
 *
 * 守住 doc/protocols/inner-brain-deliverables.md 的关键契约：
 * - R3.3：路径必须是 workspace 相对路径
 * - R4.2：成功转 asset
 * - R4.3：超大文件跳过
 * - R4.4：不存在文件跳过
 * - R4.6：未在登记表里的文件不会被发现（吸收器只看输入数组）
 * - R8.1：跳过事件写 deliverables.log
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatAssetStore } from '@utlra/chat-ir';
import { ingestDeliverables, inferKindFromMime, inferMimeByPath } from './deliverables-ingest.js';

function makeTmp(): { workDir: string; assetStore: ChatAssetStore; uploadsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kuroneko-ingest-'));
  const workDir   = path.join(root, 'workspace');
  const uploadsDir = path.join(root, 'uploads');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  return { workDir, assetStore: new ChatAssetStore(uploadsDir), uploadsDir };
}

function readLog(workDir: string): Array<Record<string, unknown>> {
  const log = path.join(workDir, '.run', 'deliverables.log');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('ingestDeliverables', () => {
  let tmp: ReturnType<typeof makeTmp>;
  beforeEach(() => { tmp = makeTmp(); });
  afterEach(() => { fs.rmSync(path.dirname(tmp.workDir), { recursive: true, force: true }); });

  it('成功路径 → asset：写盘 + meta + log', () => {
    fs.writeFileSync(path.join(tmp.workDir, 'report.md'), '# hello world\n', 'utf8');
    const r = ingestDeliverables(tmp.workDir, ['report.md'], tmp.assetStore);

    expect(r.assets).toHaveLength(1);
    const a = r.assets[0]!;
    expect(a.asset_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.source_path).toBe('report.md');
    expect(a.filename).toBe('report.md');
    expect(a.mime).toBe('text/markdown');
    expect(a.kind).toBe('file');
    expect(a.bytes).toBeGreaterThan(0);
    expect(a.registered_at).toMatch(/Z$|[+-]\d\d:\d\d$/);

    expect(r.records[0]).toEqual({ ok: true, sourcePath: 'report.md', assetId: a.asset_id });

    const meta = tmp.assetStore.get(a.asset_id);
    expect(meta?.buffer.toString('utf8')).toBe('# hello world\n');

    expect(readLog(tmp.workDir)).toContainEqual(
      expect.objectContaining({ event: 'ingest_ok', path: 'report.md', asset_id: a.asset_id }),
    );
  });

  it('图片 mime → kind=image', () => {
    fs.writeFileSync(path.join(tmp.workDir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = ingestDeliverables(tmp.workDir, ['shot.png'], tmp.assetStore);
    expect(r.assets[0]!.kind).toBe('image');
    expect(r.assets[0]!.mime).toBe('image/png');
  });

  it('R3.3：绝对路径被拒（不污染外部）', () => {
    const r = ingestDeliverables(tmp.workDir, ['C:/Windows/System32/drivers/etc/hosts'], tmp.assetStore);
    expect(r.assets).toHaveLength(0);
    expect(r.records[0]).toMatchObject({ ok: false });
    expect(readLog(tmp.workDir)[0]).toMatchObject({ event: 'ingest_skip' });
  });

  it('R3.3：含 .. 被拒', () => {
    const r = ingestDeliverables(tmp.workDir, ['../escape.md'], tmp.assetStore);
    expect(r.assets).toHaveLength(0);
    expect(r.records[0]).toMatchObject({ ok: false, reason: expect.stringContaining('unsafe') });
  });

  it('R4.4：不存在文件被跳过，不阻断同批其它项', () => {
    fs.writeFileSync(path.join(tmp.workDir, 'ok.md'), 'x', 'utf8');
    const r = ingestDeliverables(tmp.workDir, ['missing.md', 'ok.md'], tmp.assetStore);

    expect(r.assets).toHaveLength(1);
    expect(r.assets[0]!.source_path).toBe('ok.md');
    expect(r.records[0]).toMatchObject({ ok: false, sourcePath: 'missing.md' });
    expect(r.records[1]).toMatchObject({ ok: true,  sourcePath: 'ok.md' });
  });

  it('R4.3：超过 maxBytes 被跳过', () => {
    fs.writeFileSync(path.join(tmp.workDir, 'big.bin'), Buffer.alloc(2048));
    const r = ingestDeliverables(tmp.workDir, ['big.bin'], tmp.assetStore, { maxBytes: 1024 });
    expect(r.assets).toHaveLength(0);
    expect(r.records[0]).toMatchObject({ ok: false, reason: expect.stringContaining('oversize') });
  });

  it('空输入 / 空字符串：返回空结果，不写 log', () => {
    const r = ingestDeliverables(tmp.workDir, [' ', ''], tmp.assetStore);
    expect(r.assets).toHaveLength(0);
    expect(r.records).toHaveLength(0);
    expect(readLog(tmp.workDir)).toHaveLength(0);
  });

  it('目录条目被识别为 not regular file', () => {
    fs.mkdirSync(path.join(tmp.workDir, 'subdir'));
    const r = ingestDeliverables(tmp.workDir, ['subdir'], tmp.assetStore);
    expect(r.assets).toHaveLength(0);
    expect(r.records[0]).toMatchObject({ ok: false, reason: expect.stringContaining('not a regular file') });
  });
});

describe('inferMimeByPath', () => {
  it('.md → text/markdown', () => expect(inferMimeByPath('a.md')).toBe('text/markdown'));
  it('.png → image/png',     () => expect(inferMimeByPath('a.png')).toBe('image/png'));
  it('.unknown → octet',     () => expect(inferMimeByPath('a.zzz')).toBe('application/octet-stream'));
});

describe('inferKindFromMime', () => {
  it('image/*', () => expect(inferKindFromMime('image/jpeg')).toBe('image'));
  it('video/*', () => expect(inferKindFromMime('video/mp4')).toBe('video'));
  it('audio/*', () => expect(inferKindFromMime('audio/ogg')).toBe('audio'));
  it('other',   () => expect(inferKindFromMime('text/plain')).toBe('file'));
});
