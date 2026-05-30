import { describe, expect, it } from 'vitest';
import { parseInnerBrainListPagination } from './list-inner-brain-instances.js';

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
