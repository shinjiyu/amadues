import type { Tool } from '../index.js';
import { formatAgentLocalDateTime } from '../../../agent-time.js';

export const getTimeTool: Tool = {
  name: 'get_time',
  description:
    'Return the current local time in the agent-configured timezone (default Asia/Shanghai), including timezone label.',
  async call(_args) {
    return { ok: true, output: formatAgentLocalDateTime() };
  },
};
