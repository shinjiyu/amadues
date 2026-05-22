/**
 * Chat IR 附件存储：本地文件落盘 + 按 id 读取（供 `attachment.uri` 引用）。
 *
 * 任何 `ChatIRChannel` 实现都可以用这个 store 把外部 IM 的附件落地为 chat IR 的 `asset_ref`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AssetMeta {
  id: string;
  mime: string;
  name: string;
  size: number;
  created_at: string;
  ext: string;
}

export class ChatAssetStore {
  constructor(private readonly uploadsDir: string) {}

  private metaPath(id: string): string {
    return path.join(this.uploadsDir, `${id}.meta.json`);
  }

  private dataPath(id: string, ext: string): string {
    return path.join(this.uploadsDir, `${id}${ext}`);
  }

  save(buffer: Buffer, mime: string, originalName: string): AssetMeta {
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    const id = randomUUID();
    const ext = safeExt(originalName, mime);
    const meta: AssetMeta = {
      id,
      mime: mime || 'application/octet-stream',
      name: path.basename(originalName || 'file').slice(0, 200) || 'file',
      size: buffer.length,
      created_at: new Date().toISOString(),
      ext,
    };
    fs.writeFileSync(this.dataPath(id, ext), buffer);
    fs.writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2), 'utf8');
    return meta;
  }

  get(id: string): { meta: AssetMeta; buffer: Buffer } | null {
    if (!UUID_RE.test(id)) return null;
    const mp = this.metaPath(id);
    if (!fs.existsSync(mp)) return null;
    try {
      const meta = JSON.parse(fs.readFileSync(mp, 'utf8')) as AssetMeta;
      const dp = this.dataPath(id, meta.ext || '');
      if (!fs.existsSync(dp)) return null;
      return { meta, buffer: fs.readFileSync(dp) };
    } catch {
      return null;
    }
  }
}

function safeExt(originalName: string, mime: string): string {
  const fromName = path.extname(originalName || '').toLowerCase();
  if (fromName && fromName.length <= 10 && /^\.[a-z0-9.]+$/i.test(fromName)) {
    return fromName;
  }
  if (mime.includes('png')) return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('pdf')) return '.pdf';
  return '.bin';
}
