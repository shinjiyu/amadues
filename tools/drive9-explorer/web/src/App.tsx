import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Drive9Status, FileEntry, SearchResult, ViewMode } from './types.js';
import { QUICK_FOLDERS } from './types.js';
import {
  deleteFile,
  fetchStatus,
  fileIcon,
  formatBytes,
  joinPath,
  listDir,
  readFile,
  searchFiles,
  writeFile,
} from './api.js';

function pathSegments(p: string): { name: string; path: string }[] {
  if (p === '/') return [{ name: 'Drive9', path: '/' }];
  const parts = p.replace(/\/$/, '').split('/').filter(Boolean);
  const segs: { name: string; path: string }[] = [{ name: 'Drive9', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    segs.push({ name: part, path: `${acc}/` });
  }
  return segs;
}

export const App: React.FC = () => {
  const [status, setStatus] = useState<Drive9Status | null>(null);
  const [currentPath, setCurrentPath] = useState('/');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [selected, setSelected] = useState<{ path: string; name: string; isDir: boolean } | null>(
    null,
  );
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const [uploadContent, setUploadContent] = useState('');
  const [busy, setBusy] = useState(false);

  const breadcrumbs = useMemo(() => pathSegments(currentPath), [currentPath]);
  const inSearchMode = searchResults !== null;

  const loadStatus = useCallback(async () => {
    try {
      const s = await fetchStatus();
      setStatus(s);
    } catch (e) {
      setStatus({ ok: false, source: null, contextName: null, apiUrl: '' });
    }
  }, []);

  const loadDir = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    setSearchResults(null);
    setSearchQuery('');
    try {
      const data = await listDir(dirPath);
      setEntries(data.entries);
      setCurrentPath(data.path);
      setSelected(null);
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadDir('/');
  }, [loadStatus, loadDir]);

  const openEntry = async (entry: FileEntry) => {
    const fullPath = joinPath(currentPath, entry.name);
    if (entry.isDir) {
      void loadDir(fullPath.endsWith('/') ? fullPath : `${fullPath}/`);
      return;
    }
    setSelected({ path: fullPath, name: entry.name, isDir: false });
    setPreviewLoading(true);
    try {
      const data = await readFile(fullPath);
      setPreview(data.content);
    } catch (e) {
      setPreview(`读取失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  const openSearchResult = async (r: SearchResult) => {
    setSelected({ path: r.path, name: r.name, isDir: false });
    setPreviewLoading(true);
    setPreview(null);
    try {
      const data = await readFile(r.path);
      setPreview(data.content);
    } catch (e) {
      setPreview(`读取失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const data = await searchFiles(q, currentPath);
      setSearchResults(data.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const handleDelete = async () => {
    if (!selected || selected.isDir) return;
    if (!confirm(`确定删除 ${selected.name}？`)) return;
    setBusy(true);
    try {
      await deleteFile(selected.path);
      const deletedPath = selected.path;
      setSelected(null);
      setPreview(null);
      if (inSearchMode && searchResults) {
        setSearchResults(searchResults.filter((r) => r.path !== deletedPath));
      } else {
        await loadDir(currentPath);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async () => {
    const name = uploadName.trim();
    if (!name) return;
    const filePath = joinPath(currentPath, name);
    setBusy(true);
    try {
      await writeFile(filePath, uploadContent);
      setShowUpload(false);
      setUploadName('');
      setUploadContent('');
      await loadDir(currentPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-brand-icon">D9</div>
          Drive9
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-title">快捷访问</div>
          {QUICK_FOLDERS.map((f) => (
            <button
              key={f.path}
              type="button"
              className={`sidebar-item${currentPath === f.path && !inSearchMode ? ' active' : ''}`}
              onClick={() => void loadDir(f.path)}
            >
              <span>{fileIcon(f.label, true)}</span>
              {f.label}
            </button>
          ))}
        </div>

        <div className={`sidebar-status${status?.ok ? ' ok' : ' err'}`}>
          {status?.ok ? (
            <>
              ✓ 已连接
              <br />
              {status.source === 'env' ? '环境变量' : `CLI: ${status.contextName}`}
            </>
          ) : (
            <>✗ 未配置 Drive9</>
          )}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <form className="search-box" onSubmit={(e) => void handleSearch(e)}>
            <span className="search-icon">🔍</span>
            <input
              type="search"
              placeholder="语义搜索文件…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </form>
          <div className="topbar-actions">
            <div className="view-toggle">
              <button
                type="button"
                className={viewMode === 'grid' ? 'active' : ''}
                onClick={() => setViewMode('grid')}
              >
                网格
              </button>
              <button
                type="button"
                className={viewMode === 'list' ? 'active' : ''}
                onClick={() => setViewMode('list')}
              >
                列表
              </button>
            </div>
            <button type="button" className="btn btn-primary" onClick={() => setShowUpload(true)}>
              上传文件
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void loadDir(currentPath)}>
              刷新
            </button>
          </div>
        </header>

        {inSearchMode ? (
          <nav className="breadcrumb-bar">
            <span className="breadcrumb-current">搜索「{searchQuery}」</span>
            <span className="breadcrumb-sep">·</span>
            <span className="breadcrumb-muted">{searchResults?.length ?? 0} 个结果</span>
            <button
              type="button"
              className="btn btn-ghost breadcrumb-clear"
              onClick={() => {
                setSearchResults(null);
                setSearchQuery('');
                setSelected(null);
                setPreview(null);
              }}
            >
              返回浏览
            </button>
          </nav>
        ) : (
          <nav className="breadcrumb-bar">
            {breadcrumbs.map((seg, i) => (
              <React.Fragment key={seg.path}>
                {i > 0 && <span className="breadcrumb-sep">/</span>}
                {i < breadcrumbs.length - 1 ? (
                  <button type="button" className="breadcrumb-link" onClick={() => void loadDir(seg.path)}>
                    {seg.name}
                  </button>
                ) : (
                  <span className="breadcrumb-current">{seg.name}</span>
                )}
              </React.Fragment>
            ))}
          </nav>
        )}

        {error && <div className="error-banner">{error}</div>}

        <div className="content-area">
          <div className="file-panel">
            {inSearchMode ? (
              <div className="search-results">
                {searchResults!.length === 0 ? (
                  <div className="empty-state">未找到匹配文件</div>
                ) : (
                  searchResults.map((r) => {
                    const isSelected = selected?.path === r.path;
                    return (
                    <div
                      key={r.path}
                      className={`search-item${isSelected ? ' selected' : ''}`}
                      onClick={() => void openSearchResult(r)}
                      onKeyDown={(e) => e.key === 'Enter' && void openSearchResult(r)}
                      role="button"
                      tabIndex={0}
                    >
                      <span style={{ fontSize: 28 }}>{fileIcon(r.name, false)}</span>
                      <div>
                        <div style={{ fontWeight: 500 }}>{r.name}</div>
                        <div className="search-item-path">{r.path}</div>
                      </div>
                      {r.score != null && (
                        <span className="search-item-score">{(r.score * 100).toFixed(0)}%</span>
                      )}
                    </div>
                    );
                  })
                )}
              </div>
            ) : loading || searching ? (
              <div className="loading">加载中…</div>
            ) : entries.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">📂</div>
                此文件夹为空
              </div>
            ) : viewMode === 'grid' ? (
              <div className="file-grid">
                {entries.map((entry) => {
                  const fullPath = joinPath(currentPath, entry.name);
                  const isSelected = selected?.path === fullPath;
                  return (
                    <div
                      key={entry.name}
                      className={`file-card${isSelected ? ' selected' : ''}`}
                      onClick={() => void openEntry(entry)}
                      onDoubleClick={() => entry.isDir && void openEntry(entry)}
                      onKeyDown={(e) => e.key === 'Enter' && void openEntry(entry)}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="file-card-icon">{fileIcon(entry.name, entry.isDir)}</div>
                      <div className="file-card-name">{entry.name}</div>
                      {!entry.isDir && (
                        <div className="file-card-meta">{formatBytes(entry.size)}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <table className="file-list">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>大小</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => {
                    const fullPath = joinPath(currentPath, entry.name);
                    const isSelected = selected?.path === fullPath;
                    return (
                      <tr
                        key={entry.name}
                        className={isSelected ? 'selected' : ''}
                        onClick={() => void openEntry(entry)}
                      >
                        <td className="file-list-name">
                          <span>{fileIcon(entry.name, entry.isDir)}</span>
                          {entry.name}
                        </td>
                        <td>{entry.isDir ? '—' : formatBytes(entry.size)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <aside className="preview-panel">
            {selected && !selected.isDir ? (
              <>
                <div className="preview-header">
                  <div>
                    <div className="preview-title">{selected.name}</div>
                    <div className="preview-path">{selected.path}</div>
                  </div>
                  <div className="preview-actions">
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={() => void handleDelete()}
                    >
                      删除
                    </button>
                  </div>
                </div>
                <div className="preview-body">
                  {previewLoading ? (
                    <div className="loading">读取中…</div>
                  ) : (
                    <pre className="preview-content">{preview ?? ''}</pre>
                  )}
                </div>
              </>
            ) : (
              <div className="preview-empty">
                选择文件以预览内容
                <br />
                <span style={{ fontSize: 12 }}>双击文件夹进入</span>
              </div>
            )}
          </aside>
        </div>
      </div>

      {showUpload && (
        <div className="modal-overlay" onClick={() => setShowUpload(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>上传文件</h2>
            <label htmlFor="upload-name">文件名</label>
            <input
              id="upload-name"
              value={uploadName}
              onChange={(e) => setUploadName(e.target.value)}
              placeholder="example.md"
            />
            <label htmlFor="upload-content">内容</label>
            <textarea
              id="upload-content"
              value={uploadContent}
              onChange={(e) => setUploadContent(e.target.value)}
              placeholder="文件内容…"
            />
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setShowUpload(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !uploadName.trim()}
                onClick={() => void handleUpload()}
              >
                上传
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
