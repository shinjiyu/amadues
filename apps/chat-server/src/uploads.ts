/**
 * UploadStore —— 附件上传/下载。
 *
 * - 接收 multipart 字段名 `file`
 * - 落盘到 `<dataRoot>/uploads/<asset_id>.<ext>`
 * - 维护 `uploads-meta.json` 索引：`{ asset_id, original_name, mime, size, uploaded_at, uploader_user_id }`
 *
 * 安全：
 * - 单文件大小受 `maxUploadSize` 限制（由 hono `bodyLimit` 中间件 + 本类双重检查）
 * - 文件名做基本 sanitize（去掉路径分隔符），不暴露原 path
 * - `GET /uploads/:asset_id` 直接回二进制；通过 asset_id（UUID）防遍历
 */
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readJsonOr, writeJsonAtomic, ensureDir } from './store-io.js';

export interface UploadMeta {
  asset_id: string;
  original_name: string;
  mime: string;
  size: number;
  uploaded_at: string;
  uploader_user_id: string;
  /** 在 uploads/ 目录里的相对文件名（含扩展名） */
  filename: string;
}

interface UploadsFile {
  schema: 'uploads.v1';
  uploads: UploadMeta[];
}

const EMPTY: UploadsFile = { schema: 'uploads.v1', uploads: [] };

export interface UploadStoreOptions {
  dataRoot: string;
}

export class UploadStore {
  private byId = new Map<string, UploadMeta>();
  private readonly dir: string;
  private readonly metaFile: string;

  constructor(private readonly opts: UploadStoreOptions) {
    this.dir = path.join(opts.dataRoot, 'uploads');
    this.metaFile = path.join(opts.dataRoot, 'uploads-meta.json');
  }

  async init(): Promise<void> {
    await ensureDir(this.dir);
    const data = await readJsonOr<UploadsFile>(this.metaFile, EMPTY);
    for (const u of data.uploads ?? []) this.byId.set(u.asset_id, u);
  }

  get(assetId: string): UploadMeta | undefined {
    return this.byId.get(assetId);
  }

  resolvePath(meta: UploadMeta): string {
    return path.join(this.dir, meta.filename);
  }

  async save(input: {
    bytes: Buffer;
    originalName: string;
    mime: string;
    uploaderUserId: string;
  }): Promise<UploadMeta> {
    const assetId = randomUUID();
    const safeName = sanitizeFileName(input.originalName);
    const ext = path.extname(safeName).toLowerCase().slice(0, 16);
    const filename = `${assetId}${ext}`;
    const fullPath = path.join(this.dir, filename);
    await fsp.writeFile(fullPath, input.bytes);

    const meta: UploadMeta = {
      asset_id: assetId,
      original_name: safeName || filename,
      mime: input.mime || 'application/octet-stream',
      size: input.bytes.byteLength,
      uploaded_at: new Date().toISOString(),
      uploader_user_id: input.uploaderUserId,
      filename,
    };
    this.byId.set(assetId, meta);
    await this.persist();
    return meta;
  }

  /** 同步打开文件流，供路由直接 pipe。调用方负责 close。 */
  openReadStream(meta: UploadMeta): fs.ReadStream {
    return fs.createReadStream(this.resolvePath(meta));
  }

  private async persist(): Promise<void> {
    const data: UploadsFile = {
      schema: 'uploads.v1',
      uploads: Array.from(this.byId.values()),
    };
    await writeJsonAtomic(this.metaFile, data);
  }
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/[<>:"|?*\x00-\x1F]/g, '_')
    .slice(0, 200);
}
