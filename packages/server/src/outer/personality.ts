import fs from 'node:fs';
import path from 'node:path';

import type { AgentPersonality } from './autonomy-types.js';

const PERSONALITY_FILE = 'personality.json';

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0.1;
  return Math.min(1, Math.max(0, value));
}

export function defaultPersonality(now = new Date().toISOString()): AgentPersonality {
  const envRaw = process.env['UTLRA_PERSONALITY_IDLE_CHAT_P'];
  const envP = envRaw !== undefined ? Number(envRaw) : NaN;
  return {
    version: 1,
    idleChatProbability: Number.isFinite(envP) ? clampProbability(envP) : 0.1,
    updatedAt: now,
    updatedBy: 'default',
  };
}

function personalityPath(dataRoot: string): string {
  return path.join(dataRoot, 'outer', PERSONALITY_FILE);
}

export function loadPersonality(dataRoot: string): AgentPersonality {
  const fp = personalityPath(dataRoot);
  if (!fs.existsSync(fp)) {
    const p = defaultPersonality();
    savePersonality(dataRoot, p);
    return p;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as Partial<AgentPersonality>;
    const base = defaultPersonality();
    return {
      ...base,
      idleChatProbability: clampProbability(Number(raw.idleChatProbability ?? base.idleChatProbability)),
      updatedAt: raw.updatedAt ?? base.updatedAt,
      updatedBy: raw.updatedBy ?? 'system',
    };
  } catch {
    return defaultPersonality();
  }
}

export function savePersonality(dataRoot: string, personality: AgentPersonality): void {
  const dir = path.join(dataRoot, 'outer');
  fs.mkdirSync(dir, { recursive: true });
  const fp = personalityPath(dataRoot);
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(personality, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

export function patchPersonality(
  dataRoot: string,
  patch: Partial<Pick<AgentPersonality, 'idleChatProbability'>>,
): AgentPersonality {
  const current = loadPersonality(dataRoot);
  const next: AgentPersonality = {
    ...current,
    idleChatProbability:
      patch.idleChatProbability !== undefined
        ? clampProbability(patch.idleChatProbability)
        : current.idleChatProbability,
    updatedAt: new Date().toISOString(),
    updatedBy: 'system',
  };
  savePersonality(dataRoot, next);
  return next;
}
