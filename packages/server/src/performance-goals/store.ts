import fs from 'node:fs';
import path from 'node:path';
import type {
  GoalJournalEntry,
  GoalScorecard,
  PerformanceGoal,
} from './types.js';

interface ScorecardFileShape {
  scorecards: GoalScorecard[];
}

const GOALS_FILE = 'goals.json';
const SCORECARDS_FILE = 'scorecards.json';
const JOURNAL_FILE = 'journal.jsonl';

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export class PerformanceGoalStore {
  readonly dir: string;
  readonly goalsPath: string;
  readonly scorecardsPath: string;
  readonly journalPath: string;

  constructor(private readonly dataRoot: string) {
    this.dir = path.join(dataRoot, 'performance');
    this.goalsPath = path.join(this.dir, GOALS_FILE);
    this.scorecardsPath = path.join(this.dir, SCORECARDS_FILE);
    this.journalPath = path.join(this.dir, JOURNAL_FILE);
  }

  ensureFiles(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.goalsPath)) {
      fs.writeFileSync(this.goalsPath, '[]\n', 'utf8');
    }
    if (!fs.existsSync(this.scorecardsPath)) {
      fs.writeFileSync(this.scorecardsPath, JSON.stringify({ scorecards: [] }, null, 2) + '\n', 'utf8');
    }
    if (!fs.existsSync(this.journalPath)) {
      fs.writeFileSync(this.journalPath, '', 'utf8');
    }
  }

  listGoals(): PerformanceGoal[] {
    this.ensureFiles();
    const raw = readJsonFile<unknown>(this.goalsPath, []);
    return Array.isArray(raw) ? (raw as PerformanceGoal[]) : [];
  }

  getGoal(goalId: string): PerformanceGoal | null {
    return this.listGoals().find((goal) => goal.id === goalId) ?? null;
  }

  writeGoals(goals: PerformanceGoal[]): void {
    this.ensureFiles();
    fs.writeFileSync(this.goalsPath, JSON.stringify(goals, null, 2) + '\n', 'utf8');
  }

  upsertGoal(goal: PerformanceGoal): void {
    const next = this.listGoals();
    const idx = next.findIndex((entry) => entry.id === goal.id);
    if (idx >= 0) next[idx] = goal;
    else next.push(goal);
    this.writeGoals(next);
  }

  deleteGoal(goalId: string): boolean {
    const next = this.listGoals();
    const filtered = next.filter((goal) => goal.id !== goalId);
    if (filtered.length === next.length) return false;
    this.writeGoals(filtered);
    return true;
  }

  listScorecards(): GoalScorecard[] {
    this.ensureFiles();
    const raw = readJsonFile<ScorecardFileShape>(this.scorecardsPath, { scorecards: [] });
    return Array.isArray(raw.scorecards) ? raw.scorecards : [];
  }

  getScorecard(goalId: string): GoalScorecard | null {
    return this.listScorecards().find((entry) => entry.goalId === goalId) ?? null;
  }

  upsertScorecard(scorecard: GoalScorecard): void {
    const next = this.listScorecards();
    const idx = next.findIndex((entry) => entry.goalId === scorecard.goalId);
    if (idx >= 0) next[idx] = scorecard;
    else next.push(scorecard);
    fs.writeFileSync(
      this.scorecardsPath,
      JSON.stringify({ scorecards: next }, null, 2) + '\n',
      'utf8',
    );
  }

  appendJournal(entry: GoalJournalEntry): void {
    this.ensureFiles();
    fs.appendFileSync(this.journalPath, JSON.stringify(entry) + '\n', 'utf8');
  }

  listRecentJournal(goalId: string, limit = 20): GoalJournalEntry[] {
    this.ensureFiles();
    try {
      const lines = fs.readFileSync(this.journalPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .reverse();
      const out: GoalJournalEntry[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as GoalJournalEntry;
          if (parsed.goalId !== goalId) continue;
          out.push(parsed);
          if (out.length >= limit) break;
        } catch {
          // ignore malformed line
        }
      }
      return out.reverse();
    } catch {
      return [];
    }
  }
}
