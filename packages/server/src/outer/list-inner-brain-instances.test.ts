import { describe, expect, it } from 'vitest';
import {
  filterInnerBrainRecords,
  parseInnerBrainListPagination,
} from './list-inner-brain-instances.js';
import type { TaskRecord } from './inner-brain-registry.js';

describe('parseInnerBrainListPagination', () => {
  it('defaults to page 1 and pageSize 20', () => {
    expect(parseInnerBrainListPagination({})).toEqual({ page: 1, pageSize: 20 });
  });

  it('clamps invalid values', () => {
    expect(parseInnerBrainListPagination({ page: '0', pageSize: '999' })).toEqual({
      page: 1,
      pageSize: 100,
    });
    expect(parseInnerBrainListPagination({ page: 'abc', pageSize: '-5' })).toEqual({
      page: 1,
      pageSize: 1,
    });
  });

  it('parses valid query', () => {
    expect(parseInnerBrainListPagination({ page: '3', pageSize: '50' })).toEqual({
      page: 3,
      pageSize: 50,
    });
  });
});

describe('filterInnerBrainRecords', () => {
  const rows = [
    { status: 'RUNNING' },
    { status: 'DONE' },
    { status: 'AWAITING' },
    { status: 'ERROR' },
    { status: 'BLOCKED' },
  ] as TaskRecord[];

  it('defaults to live statuses', () => {
    expect(filterInnerBrainRecords(rows).map((r) => r.status)).toEqual([
      'RUNNING',
      'AWAITING',
      'BLOCKED',
    ]);
    expect(filterInnerBrainRecords(rows, 'live')).toHaveLength(3);
  });

  it('all returns everything', () => {
    expect(filterInnerBrainRecords(rows, 'all')).toHaveLength(5);
  });

  it('accepts comma status list', () => {
    expect(filterInnerBrainRecords(rows, 'done,error').map((r) => r.status)).toEqual([
      'DONE',
      'ERROR',
    ]);
  });
});
