/**
 * 战略规划层 — strategyStore（ADL STRATEGY-PLANNING-LAYER.md §11）。
 *
 * current.json（覆盖，最新 StrategyArtifact）+ journal-YYYY-MM.jsonl（按月轮转，每次 plan 留痕）。
 * 唯一写权属 strategyPlanner.plan()；本类只做读写，不做决策。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { StrategyArtifact, StrategyJournalEntry } from './strategy-types.js';

export class StrategyStore {
  private readonly dir: string;

  constructor(dataRoot: string) {
    this.dir = path.join(dataRoot, 'strategy');
  }

  private get _currentFile(): string {
    return path.join(this.dir, 'current.json');
  }

  private _journalFile(monthIso: string): string {
    return path.join(this.dir, `journal-${monthIso}.jsonl`);
  }

  loadCurrent(): StrategyArtifact | null {
    try {
      return JSON.parse(fs.readFileSync(this._currentFile, 'utf8')) as StrategyArtifact;
    } catch {
      return null;
    }
  }

  writeCurrent(artifact: StrategyArtifact): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this._currentFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(artifact, null, 2), 'utf8');
    fs.renameSync(tmp, this._currentFile);
  }

  appendJournal(entry: StrategyJournalEntry): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const month = entry.at.slice(0, 7); // YYYY-MM
    fs.appendFileSync(this._journalFile(month), JSON.stringify(entry) + '\n', 'utf8');
  }

  readJournal(limit = 100): StrategyJournalEntry[] {
    if (!fs.existsSync(this.dir)) return [];
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => /^journal-\d{4}-\d{2}\.jsonl$/.test(f))
      .sort()
      .map((f) => path.join(this.dir, f));
    const out: StrategyJournalEntry[] = [];
    for (const file of files) {
      try {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (line.trim()) out.push(JSON.parse(line) as StrategyJournalEntry);
        }
      } catch {
        /* skip corrupt file */
      }
    }
    return out.slice(-limit);
  }
}
