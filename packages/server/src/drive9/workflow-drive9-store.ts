/**
 * drive9 `/workflows/shared/` — Executable Workflow 共享层（P1）
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md
 */
import type { Drive9Client } from './drive9-client.js';
import { getDrive9Client, initDrive9Client } from './drive9-client.js';
import type { ExecutableWorkflow } from '../outer/executable-workflow-types.js';

export const SHARED_WORKFLOWS_DIR = '/workflows/shared';

export function workflowDrive9Path(id: string, version: string): string {
  const safeId = id.replace(/[^\w.-]/g, '_');
  const safeVer = version.replace(/[^\w.-]/g, '_');
  return `${SHARED_WORKFLOWS_DIR}/${safeId}@${safeVer}.json`;
}

export function serializeWorkflow(wf: ExecutableWorkflow): string {
  return JSON.stringify(wf, null, 2);
}

export function deserializeWorkflow(raw: string, fallbackId: string): ExecutableWorkflow {
  const parsed = JSON.parse(raw) as ExecutableWorkflow;
  if (!parsed?.id) parsed.id = fallbackId;
  if (!parsed.version) throw new Error('workflow missing version');
  if (!Array.isArray(parsed.steps)) throw new Error('workflow missing steps');
  return parsed;
}

export class WorkflowDrive9Store {
  constructor(private readonly drive9: Drive9Client) {}

  /** fire-and-forget 写入共享池 */
  storeShared(wf: ExecutableWorkflow): void {
    const path = workflowDrive9Path(wf.id, wf.version);
    const body = serializeWorkflow(wf);
    void this.drive9
      .write(path, body)
      .catch((e: unknown) =>
        console.warn('[drive9-workflow] storeShared failed:', (e as Error).message),
      );
  }

  async storeSharedAwait(wf: ExecutableWorkflow): Promise<void> {
    await this.drive9.write(workflowDrive9Path(wf.id, wf.version), serializeWorkflow(wf));
  }

  async getShared(id: string, version: string): Promise<ExecutableWorkflow | null> {
    try {
      const raw = await this.drive9.read(workflowDrive9Path(id, version));
      return deserializeWorkflow(raw, id);
    } catch {
      return null;
    }
  }

  async listShared(limit = 100): Promise<Array<{ id: string; version: string; name: string }>> {
    try {
      const entries = await this.drive9.list(SHARED_WORKFLOWS_DIR);
      const out: Array<{ id: string; version: string; name: string }> = [];
      for (const e of entries) {
        if (e.isDir || !e.name.endsWith('.json')) continue;
        const base = e.name.replace(/\.json$/, '');
        const at = base.lastIndexOf('@');
        if (at <= 0) continue;
        out.push({
          id: base.slice(0, at),
          version: base.slice(at + 1),
          name: e.name,
        });
        if (out.length >= limit) break;
      }
      return out;
    } catch (e) {
      console.warn('[drive9-workflow] listShared failed:', (e as Error).message);
      return [];
    }
  }
}

let _instance: WorkflowDrive9Store | null | undefined;

export function getWorkflowDrive9Store(): WorkflowDrive9Store | null {
  if (_instance !== undefined) return _instance;
  const client = getDrive9Client();
  _instance = client ? new WorkflowDrive9Store(client) : null;
  return _instance;
}

export function initWorkflowDrive9Store(apiKey?: string, apiUrl?: string): WorkflowDrive9Store | null {
  if (apiKey) {
    const client = getDrive9Client() ?? initDrive9Client(apiKey, apiUrl);
    _instance = new WorkflowDrive9Store(client);
    return _instance;
  }
  return getWorkflowDrive9Store();
}

export function initWorkflowDrive9StoreWithClient(client: Drive9Client): WorkflowDrive9Store {
  _instance = new WorkflowDrive9Store(client);
  return _instance;
}
