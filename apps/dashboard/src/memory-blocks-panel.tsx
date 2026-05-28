import { useCallback, useEffect, useState } from 'react';

type MemoryBlockRow = {
  blockId: string;
  strategy: string;
  title?: string;
  description: string;
  system?: boolean;
  entry_count?: number;
};

type MemoryEntryRow = {
  key: string;
  meta: Record<string, unknown> | null;
};

const cardStyle: React.CSSProperties = {
  background: '#0d1117',
  border: '1px solid #2a3142',
  borderRadius: 6,
  padding: '0.75rem',
  fontSize: 12,
  color: '#c8d8ff',
};

const muted: React.CSSProperties = { fontSize: 11, color: '#5a6180', margin: '4px 0 0' };

export function MemoryBlocksPanel({ apiPrefix }: { apiPrefix: string }) {
  const [blocks, setBlocks] = useState<MemoryBlockRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entries, setEntries] = useState<MemoryEntryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refreshBlocks = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`${apiPrefix}/memory/blocks`);
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as { blocks?: MemoryBlockRow[] };
      const list = j.blocks ?? [];
      setBlocks(list);
      setSelectedId((prev) => {
        if (prev && list.some((b) => b.blockId === prev)) return prev;
        return list[0]?.blockId ?? null;
      });
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [apiPrefix]);

  const loadEntries = useCallback(
    async (blockId: string) => {
      try {
        const r = await fetch(`${apiPrefix}/memory/blocks/${encodeURIComponent(blockId)}/entries`);
        if (!r.ok) throw new Error(await r.text());
        const j = (await r.json()) as { entries?: MemoryEntryRow[] };
        setEntries(j.entries ?? []);
      } catch (e) {
        setEntries([]);
        setErr(String(e));
      }
    },
    [apiPrefix],
  );

  useEffect(() => {
    void refreshBlocks();
    const t = setInterval(() => { void refreshBlocks(); }, 15_000);
    return () => clearInterval(t);
  }, [refreshBlocks]);

  useEffect(() => {
    if (!selectedId) {
      setEntries([]);
      return;
    }
    void loadEntries(selectedId);
  }, [selectedId, loadEntries]);

  const selected = blocks.find((b) => b.blockId === selectedId);

  return (
    <div style={{ flex: '1 1 100%', minWidth: 320 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: '#8b92a8' }}>📒 Memory Block（记事本）</h3>
        <button
          type="button"
          onClick={() => { void refreshBlocks(); }}
          disabled={loading}
          style={{
            fontSize: 11,
            padding: '2px 8px',
            background: '#1d2333',
            border: '1px solid #2a3142',
            borderRadius: 4,
            color: '#8b92a8',
            cursor: 'pointer',
          }}
        >
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>
      {err && <p style={{ color: '#e06c75', fontSize: 12 }}>{err}</p>}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 220px', maxHeight: 360, overflowY: 'auto' }}>
          {blocks.length === 0 ? (
            <p style={muted}>（暂无块；外脑可用 memory_block_create 创建 notebook）</p>
          ) : (
            blocks.map((b) => (
              <button
                key={b.blockId}
                type="button"
                onClick={() => setSelectedId(b.blockId)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  marginBottom: 4,
                  padding: '6px 8px',
                  background: selectedId === b.blockId ? '#1a2a4a' : '#121820',
                  border: `1px solid ${selectedId === b.blockId ? '#5b7ac5' : '#2a3142'}`,
                  borderRadius: 4,
                  color: '#c8d8ff',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                <strong>{b.title ?? b.blockId}</strong>
                <span style={{ display: 'block', color: '#5a6180', fontSize: 10 }}>
                  {b.blockId} · {b.strategy}
                  {b.system ? ' · 系统' : ''} · {b.entry_count ?? 0} 条
                </span>
              </button>
            ))
          )}
        </div>
        <div style={{ flex: '1 1 280px' }}>
          {selected ? (
            <>
              <p style={{ margin: '0 0 6px', fontSize: 12, color: '#8b92a8' }}>
                {selected.description}
              </p>
              <div style={cardStyle}>
                {entries.length === 0 ? (
                  <span style={{ color: '#5a6180' }}>（该块暂无 entry）</span>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {entries.map((e) => (
                      <li key={e.key} style={{ marginBottom: 8 }}>
                        <code style={{ color: '#98c379' }}>{e.key}</code>
                        {e.meta && (
                          <pre
                            style={{
                              margin: '4px 0 0',
                              fontSize: 11,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              color: '#8b92a8',
                            }}
                          >
                            {JSON.stringify(e.meta, null, 2)}
                          </pre>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : (
            <p style={muted}>选择左侧块查看条目（keychain 不展示 value）</p>
          )}
        </div>
      </div>
      <p style={muted}>
        只读视图；写入/删除请用外脑工具 memory_block_*。数据在对应 Agent 的 DATA_ROOT/vault/blocks/（本地，不上 drive9）。
      </p>
    </div>
  );
}
