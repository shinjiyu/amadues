/**
 * Thin accept for a teammate that lives in another process.
 * The host still only sees accept. This function does not store the URL.
 *
 * @see doc/structurizr/AGENT-ADAPTER.md
 */
import type { AgentTurn, AgentTurnResult } from './host.js';

export function createRemoteAccept(opts: {
  url: string;
  fetch?: typeof fetch;
}): (turn: AgentTurn) => Promise<AgentTurnResult> {
  const fetchImpl = opts.fetch ?? fetch;
  return async (turn) => {
    const res = await fetchImpl(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: turn.message,
        roster: turn.roster,
        peers: turn.peers,
      }),
    });
    if (!res.ok) {
      throw new Error(`accept failed: ${res.status}`);
    }
    const body = (await res.json()) as AgentTurnResult;
    return {
      say: body.say,
      presence: body.presence,
      handoff: body.handoff,
    };
  };
}
