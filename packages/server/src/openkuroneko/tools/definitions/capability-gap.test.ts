import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  capabilityGapTool,
  readPendingGaps,
  resolveGap,
  setCapabilityGapTempDir,
} from './capability-gap.js';

describe('capabilityGapTool', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuroneko-gap-'));
    setCapabilityGapTempDir(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('records pending gaps, deduplicates repeats, and lists them', async () => {
    const first = await capabilityGapTool.call({
      gap: 'Missing playwright login skill',
      reason: 'Current milestone needs browser automation reuse',
    });
    expect(first.ok).toBe(true);
    expect(first.output).toContain('Capability gap recorded');
    expect(readPendingGaps(tempDir)).toHaveLength(1);

    const duplicate = await capabilityGapTool.call({
      gap: '  missing   playwright login skill  ',
      reason: 'duplicate wording should not append',
    });
    expect(duplicate.ok).toBe(true);
    expect(duplicate.output).toContain('already pending');
    expect(readPendingGaps(tempDir)).toHaveLength(1);

    const listed = await capabilityGapTool.call({ action: 'list' });
    expect(listed.ok).toBe(true);
    expect(listed.output).toContain('Pending capability gaps (1)');
    expect(listed.output).toContain('Missing playwright login skill');
  });

  it('resolves pending gaps and removes them from the next loop backlog', async () => {
    await capabilityGapTool.call({
      gap: 'Missing markdown attachment handoff',
      reason: 'Need to send deliverables as real assets',
    });
    expect(readPendingGaps(tempDir)).toHaveLength(1);

    const resolved = await capabilityGapTool.call({
      action: 'resolve',
      gap: 'missing markdown attachment handoff',
      resolution: 'Registered deliverables through asset ingestion pipeline',
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.output).toContain('resolved');
    expect(readPendingGaps(tempDir)).toHaveLength(0);
  });

  it('resolveGap returns false when no pending record matches', () => {
    expect(resolveGap(tempDir, 'non-existent gap')).toBe(false);
  });
});
