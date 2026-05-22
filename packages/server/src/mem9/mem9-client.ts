/**
 * Mem9Client — REST client for mem9 / mnemo-server
 *
 * API v1alpha2 (preferred):
 *   Auth:       X-API-Key header
 *   Write attr: X-Mnemo-Agent-Id header  (tags memories with the writing agent)
 *   Search:     ?agent_id=<id>           (filter memories by agent)
 *
 * IMPORTANT: store() is fully async.
 *   The server queues the write, runs LLM extraction in the background,
 *   and returns {"status":"accepted"} immediately. The LLM may:
 *   - Rewrite / condense content
 *   - Auto-add tags
 *   - Deduplicate similar memories
 *   Callers must wait a few seconds before searching for freshly stored content.
 *
 * Tenant provisioning (v1alpha1, no auth):
 *   POST /v1alpha1/mem9s  → { id: string }
 *
 * Single-key multi-agent pattern used in utlraKuroneko:
 *   - One apiKey per team/project (shared Tenant)
 *   - agentId on write: X-Mnemo-Agent-Id header  ("kuro", "shiro", "shared")
 *   - agentId on search: ?agent_id=kuro           (server-side filtering)
 */

export interface Mem9Config {
  apiUrl?: string;   // default: https://api.mem9.ai
  apiKey: string;
  agentId?: string;  // default X-Mnemo-Agent-Id for writes
}

export interface Memory {
  id: string;
  content: string;
  memory_type?: string;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  agent_id?: string;
  updated_by?: string;
  state?: string;
  version?: number;
  /** ISO 8601，服务端写入时刻，原生字段，不经 LLM 修改。用于客户端时序排序。 */
  created_at?: string;
  updated_at?: string;
  /** 人类可读相对时间，如 "2 hours ago" */
  relative_age?: string;
  score?: number;
}

export interface SearchResult {
  memories: Memory[];
  total: number;
  limit: number;
  offset: number;
}

export interface StoreResult {
  status: string;   // "accepted"
}

export interface SearchOptions {
  query?: string;
  agentId?: string;  // filter: ?agent_id=<id>
  limit?: number;
  offset?: number;
}

export interface IngestMessage {
  role: string;
  content: string;
}

export interface IngestInput {
  messages: IngestMessage[];
  session_id: string;
  agent_id: string;
  /** "smart" = 服务端 LLM 提取多条洞见；"raw" = 当作单块处理（仍经 LLM） */
  mode?: 'smart' | 'raw';
}

export interface IngestResult {
  status: 'accepted' | 'complete' | 'partial' | 'failed';
  memories_changed?: number;
  warnings?: number;
  error?: string;
}

export interface WriteOptions {
  content: string;
  agentId?: string;  // override instance-level agentId (write attribution)
  metadata?: Record<string, unknown>;
}

export interface UpdateOptions {
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface ProvisionResult {
  id: string;
}

export class Mem9Error extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'Mem9Error';
  }
}

export class Mem9Client {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly agentId: string | undefined;

  constructor(config: Mem9Config) {
    this.base    = (config.apiUrl ?? 'https://api.mem9.ai').replace(/\/$/, '');
    this.apiKey  = config.apiKey;
    this.agentId = config.agentId;
  }

  // ── Tenant provisioning ────────────────────────────────────────────────────

  /**
   * Create a new Tenant. No auth required.
   * Returns the new tenant ID to use as apiKey going forward.
   */
  static async provision(apiUrl = 'https://api.mem9.ai'): Promise<ProvisionResult> {
    const url = `${apiUrl.replace(/\/$/, '')}/v1alpha1/mem9s`;
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) {
      throw new Mem9Error(`Provision failed: ${res.status}`, res.status, await res.text());
    }
    return res.json() as Promise<ProvisionResult>;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private writeHeaders(agentIdOverride?: string): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-API-Key': this.apiKey,
    };
    const aid = agentIdOverride ?? this.agentId;
    if (aid) h['X-Mnemo-Agent-Id'] = aid;
    return h;
  }

  private authHeaders(): Record<string, string> {
    return { 'X-API-Key': this.apiKey };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: headers ?? this.authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Mem9Error(
        `mem9 ${method} ${path} → ${res.status}`,
        res.status,
        await res.text(),
      );
    }
    const text = await res.text();
    return text ? JSON.parse(text) as T : undefined as T;
  }

  // ── Write (async / fire-and-forget) ───────────────────────────────────────

  /**
   * Store a memory. Returns immediately with {status:"accepted"}.
   * The LLM processes the content in the background (typically 2-5 seconds).
   * Content may be rewritten / condensed by the LLM.
   */
  async store(opts: WriteOptions): Promise<StoreResult> {
    return this.request<StoreResult>(
      'POST',
      '/v1alpha2/mem9s/memories',
      { content: opts.content, metadata: opts.metadata ?? {} },
      this.writeHeaders(opts.agentId),
    );
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  async get(id: string): Promise<Memory> {
    return this.request<Memory>('GET', `/v1alpha2/mem9s/memories/${id}`);
  }

  async update(id: string, opts: UpdateOptions): Promise<Memory> {
    return this.request<Memory>(
      'PUT',
      `/v1alpha2/mem9s/memories/${id}`,
      opts,
      this.writeHeaders(),
    );
  }

  async delete(id: string): Promise<void> {
    return this.request<void>(
      'DELETE',
      `/v1alpha2/mem9s/memories/${id}`,
      undefined,
      this.writeHeaders(),
    );
  }

  /**
   * Ingest a conversation session for LLM-based insight extraction.
   * Accepts an array of messages (role + content) and extracts memories asynchronously.
   * mode: "smart" extracts multiple distinct insights; "raw" stores as a single block.
   * Returns immediately with {status:"accepted"}.
   */
  async ingest(opts: IngestInput): Promise<IngestResult> {
    return this.request<IngestResult>(
      'POST',
      '/v1alpha2/mem9s/memories',
      { messages: opts.messages, session_id: opts.session_id, agent_id: opts.agent_id, mode: opts.mode ?? 'smart' },
      this.writeHeaders(opts.agent_id),
    );
  }

  // ── Search / List ──────────────────────────────────────────────────────────

  /**
   * Search or list memories.
   * - opts.query: semantic search query (omit to list all)
   * - opts.agentId: server-side filter by agent_id (uses ?agent_id= param)
   */
  async search(opts: SearchOptions = {}): Promise<Memory[]> {
    const params = new URLSearchParams();
    if (opts.query)   params.set('q',        opts.query);
    if (opts.agentId) params.set('agent_id', opts.agentId);
    if (opts.limit)   params.set('limit',    String(opts.limit));
    if (opts.offset)  params.set('offset',   String(opts.offset));

    const qs = params.toString();
    const result = await this.request<SearchResult>(
      'GET',
      `/v1alpha2/mem9s/memories${qs ? '?' + qs : ''}`,
    );
    return result?.memories ?? [];
  }
}
