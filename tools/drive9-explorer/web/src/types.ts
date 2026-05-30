export interface FileEntry {
  name: string;
  size: number;
  isDir: boolean;
}

export interface SearchResult {
  path: string;
  name: string;
  size_bytes: number;
  score?: number;
}

export interface Drive9Status {
  ok: boolean;
  source: 'env' | 'cli-config' | null;
  contextName: string | null;
  apiUrl: string;
}

export type ViewMode = 'grid' | 'list';

export const QUICK_FOLDERS = [
  { label: '全部文件', path: '/' },
  { label: '共享技能', path: '/skills/shared/' },
  { label: '共享知识', path: '/knowledge/shared/' },
  { label: '技能根目录', path: '/skills/' },
  { label: '知识根目录', path: '/knowledge/' },
  { label: '约束', path: '/constraints/' },
] as const;
