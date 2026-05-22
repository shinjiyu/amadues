import fs from 'node:fs';
import path from 'node:path';
import type { MemoryLayer2 } from './index.js';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createMemoryLayer2(tempDir: string): MemoryLayer2 {
  const memDir = path.join(tempDir, 'memory');
  fs.mkdirSync(memDir, { recursive: true });

  const tasksPath = path.join(memDir, 'TASKS.md');
  const dailyLogPath = () => path.join(memDir, `daily-${today()}.md`);

  return {
    appendDailyLog(entry) {
      const ts = new Date().toISOString();
      fs.appendFileSync(dailyLogPath(), `\n<!-- ${ts} -->\n${entry}\n`, 'utf8');
    },
    readDailyLog() {
      const p = dailyLogPath();
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    },
    readTasks() {
      return fs.existsSync(tasksPath) ? fs.readFileSync(tasksPath, 'utf8') : '';
    },
    writeTasks(content) {
      fs.writeFileSync(tasksPath, content, 'utf8');
    },
  };
}
