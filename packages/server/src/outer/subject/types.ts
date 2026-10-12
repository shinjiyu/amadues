export interface SubjectGoal {
  id: string;
  text: string;
  keywords: string[];
  priority: number;
  /** Absent on legacy rows. Load fills it from the life graph. */
  layer?: 'identity' | 'north_star' | 'mission' | 'commitment' | 'constraint' | 'success_signal';
  relatesTo?: string[];
  relation?: 'serves' | 'constrains' | 'evidences' | 'commits';
}

export interface SubjectDrives {
  curiosity: number;
  social: number;
  completion: number;
}

export type SignalKind = 'message' | 'deferred' | 'event' | 'status';

export interface SignalParse {
  source: string;
  kind: 'message' | 'deferred' | 'event';
  intent_category: 'request' | 'statement' | 'event' | 'suspicious_instruction';
  entities: string[];
  sentiment: 'positive' | 'negative' | 'neutral';
}

export interface SubjectSignal {
  source: string;
  kind: SignalKind;
  raw: string;
  threadId?: string | null;
  at?: string;
  messageId?: string;
  /** Thread history is an observation only. It is not a new human turn to defer or ack. */
  historical?: boolean;
}

export interface DeferredItem {
  id: string;
  source: string;
  kind: string;
  threadId: string | null;
  raw: string;
  parsed: SignalParse;
  createdAt: string;
  revisitAt: string;
  statusAckAt: string | null;
  status: 'open' | 'revisited' | 'dropped';
}

export interface InboxItem {
  id: string;
  source: string;
  kind: 'message' | 'event';
  threadId: string | null;
  raw: string;
  at: string;
  messageId?: string;
}

export interface SubjectState {
  version: 1;
  identity: string;
  goals: SubjectGoal[];
  drives: SubjectDrives;
  lastAccruedAt: string;
  accrualPerHour: SubjectDrives;
  thinkThreshold: 0.6;
  driveWeight: 0.3;
  decayOnAct: 0.5;
  driveThinkCooldownMs: number;
  lastDriveOnlyThinkAt: string | null;
  deferRevisitMs: number;
  deferredCap: number;
  shortTerm: Array<{ at: string; action: string; result: string }>;
  deferred: DeferredItem[];
  lease: { owner: string; until: string } | null;
}

export interface ScoreDims {
  alignment?: number;
  novelty?: number;
  cost?: number;
  risk?: number;
  socialPressure?: number;
  completionPressure?: number;
}

export interface Candidate {
  /** Abstract kind. Set before projection. Legacy rows may omit it until materialize. */
  type?: string;
  /** Concrete whitelist action after projection. */
  action: string;
  args: Record<string, unknown>;
  rationale?: string;
}

export interface ScoreRow {
  action: string;
  score: number;
  reason?: string;
  dims?: ScoreDims;
}

export interface Decision {
  chosen: Candidate | null;
  total: number;
  rejected: Array<{ action: string; why: string }>;
  reason: string;
}

export type ThinkTrigger = 'inbound' | 'heartbeat_tail';

export interface ThinkLogRecord {
  at: string;
  trigger: ThinkTrigger;
  drivesBefore: SubjectDrives;
  drivesAfter: SubjectDrives;
  signals: unknown[];
  candidates: Candidate[];
  scores: ScoreRow[];
  rejected: Array<{ action: string; why: string }>;
  chosen: string;
  /** Abstract type of the chosen candidate, when projection ran. */
  abstractType?: string;
  reason: string;
  selfInitiated: boolean;
  result: string;
  statusPosted: boolean;
  truncated?: boolean;
  statusDroppedThreads?: string[];
}
