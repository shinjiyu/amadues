/**
 * EW 自优化修订提案持久化（W15）
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md §6.2
 */
import fs from 'node:fs';
import path from 'node:path';

const REL = path.join('autonomy', 'workflow-evolution.json');

export type EvolutionProposalStatus = 'pending' | 'dispatched' | 'done' | 'suppressed';

export interface WorkflowEvolutionProposal {
  id: string;
  workflowId: string;
  version: string;
  kpiId?: string;
  signature: string;
  reasons: string[];
  charter: string;
  status: EvolutionProposalStatus;
  createdAt: string;
  updatedAt: string;
  sourceInstanceId?: string;
  sourceWorkDir?: string;
}

interface EvolutionFile {
  version: 1;
  proposals: WorkflowEvolutionProposal[];
}

function filePath(dataRoot: string): string {
  return path.join(dataRoot, REL);
}

function readFile(dataRoot: string): EvolutionFile {
  const fp = filePath(dataRoot);
  if (!fs.existsSync(fp)) return { version: 1, proposals: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as EvolutionFile;
    if (!raw || !Array.isArray(raw.proposals)) return { version: 1, proposals: [] };
    return { version: 1, proposals: raw.proposals };
  } catch {
    return { version: 1, proposals: [] };
  }
}

function writeFile(dataRoot: string, data: EvolutionFile): void {
  const fp = filePath(dataRoot);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
}

export function listEvolutionProposals(
  dataRoot: string,
  status?: EvolutionProposalStatus,
): WorkflowEvolutionProposal[] {
  const all = readFile(dataRoot).proposals;
  return status ? all.filter((p) => p.status === status) : all;
}

export function upsertPendingEvolution(
  dataRoot: string,
  input: Omit<WorkflowEvolutionProposal, 'id' | 'status' | 'createdAt' | 'updatedAt'> & {
    id?: string;
  },
): { proposal: WorkflowEvolutionProposal; created: boolean } {
  const data = readFile(dataRoot);
  const now = new Date().toISOString();
  const existing = data.proposals.find(
    (p) =>
      p.status === 'pending' &&
      p.workflowId === input.workflowId &&
      p.version === input.version &&
      p.signature === input.signature,
  );
  if (existing) {
    existing.updatedAt = now;
    existing.reasons = input.reasons;
    existing.charter = input.charter;
    if (input.kpiId) existing.kpiId = input.kpiId;
    writeFile(dataRoot, data);
    return { proposal: existing, created: false };
  }

  const proposal: WorkflowEvolutionProposal = {
    id: input.id ?? `evo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    workflowId: input.workflowId,
    version: input.version,
    kpiId: input.kpiId,
    signature: input.signature,
    reasons: input.reasons,
    charter: input.charter,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    sourceInstanceId: input.sourceInstanceId,
    sourceWorkDir: input.sourceWorkDir,
  };
  data.proposals.push(proposal);
  // 保留最近 100 条
  if (data.proposals.length > 100) {
    data.proposals = data.proposals.slice(-100);
  }
  writeFile(dataRoot, data);
  return { proposal, created: true };
}

export function markEvolutionStatus(
  dataRoot: string,
  id: string,
  status: EvolutionProposalStatus,
): WorkflowEvolutionProposal | null {
  const data = readFile(dataRoot);
  const hit = data.proposals.find((p) => p.id === id);
  if (!hit) return null;
  hit.status = status;
  hit.updatedAt = new Date().toISOString();
  writeFile(dataRoot, data);
  return hit;
}
