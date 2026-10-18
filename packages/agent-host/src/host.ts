/**
 * Agent host. Roster, group membership, presence, and one-hop handoff.
 * Does not decide who speaks in a group.
 *
 * @see doc/structurizr/AGENT-HOST.md
 */
import { randomUUID } from 'node:crypto';

export interface AgentProfile {
  id: string;
  name: string;
  job: string;
  createdAt: string;
}

export interface GroupProfile {
  id: string;
  name: string;
  agentIds: string[];
  createdAt: string;
}

export interface PresenceCard {
  agentId: string;
  doing: string;
  waitingOn: string | null;
  updatedAt: string;
}

export interface HostParty {
  kind: 'human' | 'agent';
  id: string;
}

export interface HostTarget {
  kind: 'agent' | 'group';
  id: string;
}

export interface HostMessage {
  id: string;
  from: HostParty;
  to: HostTarget;
  text: string;
  at: string;
}

/** Public name of another registered teammate. */
export interface RosterEntry {
  id: string;
  name: string;
  job: string;
}

export interface AgentTurn {
  message: HostMessage;
  /** Other registered teammates. The receiver is not in this list. */
  roster: RosterEntry[];
  peers: PresenceCard[];
}

export interface AgentTurnResult {
  say?: string;
  presence?: { doing: string; waitingOn?: string | null };
  handoff?: { toAgentId: string; note: string };
}

/** Anything that can take one turn. No Amadeus types. */
export interface AgentAdapter {
  profile: AgentProfile;
  accept(turn: AgentTurn): Promise<AgentTurnResult>;
}

export interface DeliveredTurn {
  toAgentId: string;
  said: string | null;
}

export interface GroupPostResult {
  scheduled: false;
  reason: 'group-turn-deferred';
}

function nowIso(): string {
  return new Date().toISOString();
}

export class AgentHost {
  private readonly agents = new Map<string, AgentAdapter>();
  private readonly groups = new Map<string, GroupProfile>();
  private readonly presence = new Map<string, PresenceCard>();
  private readonly groupLog = new Map<string, HostMessage[]>();

  createAgent(input: {
    name: string;
    job: string;
    accept: AgentAdapter['accept'];
  }): AgentProfile {
    const name = input.name.trim();
    const job = input.job.trim();
    if (!name) throw new Error('agent name required');
    const profile: AgentProfile = {
      id: randomUUID(),
      name,
      job,
      createdAt: nowIso(),
    };
    this.agents.set(profile.id, { profile, accept: input.accept });
    this.presence.set(profile.id, {
      agentId: profile.id,
      doing: '',
      waitingOn: null,
      updatedAt: profile.createdAt,
    });
    return profile;
  }

  listAgents(): AgentProfile[] {
    return [...this.agents.values()].map((agent) => agent.profile);
  }

  createGroup(input: { name: string; agentIds: string[] }): GroupProfile {
    const name = input.name.trim();
    if (!name) throw new Error('group name required');
    const agentIds = [...new Set(input.agentIds)];
    if (agentIds.length < 2) throw new Error('a group needs at least two agents');
    for (const id of agentIds) {
      if (!this.agents.has(id)) throw new Error(`unknown agent: ${id}`);
    }
    const group: GroupProfile = {
      id: randomUUID(),
      name,
      agentIds,
      createdAt: nowIso(),
    };
    this.groups.set(group.id, group);
    this.groupLog.set(group.id, []);
    return group;
  }

  listGroups(): GroupProfile[] {
    return [...this.groups.values()];
  }

  listPresence(agentIds?: string[]): PresenceCard[] {
    const ids = agentIds ?? [...this.presence.keys()];
    return ids.flatMap((id) => {
      const card = this.presence.get(id);
      return card ? [card] : [];
    });
  }

  /**
   * Store a group message. Does not call any agent.
   * The terminal decides who speaks, then calls deliver.
   */
  recordGroupMessage(message: HostMessage): GroupPostResult {
    if (message.to.kind !== 'group') throw new Error('not a group message');
    const group = this.groups.get(message.to.id);
    if (!group) throw new Error(`unknown group: ${message.to.id}`);
    const log = this.groupLog.get(group.id);
    if (!log) throw new Error(`missing group log: ${group.id}`);
    log.push(message);
    return { scheduled: false, reason: 'group-turn-deferred' };
  }

  groupMessages(groupId: string): HostMessage[] {
    return [...(this.groupLog.get(groupId) ?? [])];
  }

  async deliver(message: HostMessage): Promise<DeliveredTurn[]> {
    if (message.to.kind === 'group') {
      this.recordGroupMessage(message);
      return [];
    }
    return this.deliverToAgent(message, 0);
  }

  private async deliverToAgent(message: HostMessage, depth: number): Promise<DeliveredTurn[]> {
    const agent = this.agents.get(message.to.id);
    if (!agent) throw new Error(`unknown agent: ${message.to.id}`);
    const roster = this.listAgents()
      .filter((profile) => profile.id !== agent.profile.id)
      .map((profile) => ({ id: profile.id, name: profile.name, job: profile.job }));
    const peers = this.listPresence().filter((card) => card.agentId !== agent.profile.id);
    const result = await agent.accept({ message, roster, peers });
    if (result.presence) {
      this.presence.set(agent.profile.id, {
        agentId: agent.profile.id,
        doing: result.presence.doing,
        waitingOn: result.presence.waitingOn ?? null,
        updatedAt: nowIso(),
      });
    }
    const said = result.say == null || result.say.trim() === '' ? null : result.say;
    const delivered: DeliveredTurn[] = [{ toAgentId: agent.profile.id, said }];
    if (result.handoff && depth < 1) {
      if (!this.agents.has(result.handoff.toAgentId)) {
        throw new Error(`unknown agent: ${result.handoff.toAgentId}`);
      }
      const next: HostMessage = {
        id: randomUUID(),
        from: { kind: 'agent', id: agent.profile.id },
        to: { kind: 'agent', id: result.handoff.toAgentId },
        text: result.handoff.note,
        at: nowIso(),
      };
      delivered.push(...(await this.deliverToAgent(next, depth + 1)));
    }
    return delivered;
  }
}
