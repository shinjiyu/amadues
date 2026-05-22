import type { Tool } from '../index.js';

export const getTimeTool: Tool = {
  name: 'get_time',
  description: 'Return the current UTC time as an ISO 8601 string.',
  async call(_args) {
    return { ok: true, output: new Date().toISOString() };
  },
};
