import { AgentSummary, CockpitEvent, DataSource, SessionSummary, Turn, TurnDetail, TurnList } from '../types';
import { buildAgents, buildTurns, sessionGroup, summarizeSession } from './turns';

// Reads a recorded .jsonl file. A file has no turn list, so the turns are
// grouped from its events (./turns), and served through the same two calls
// the live source answers from the API: the turn list without events, and one
// turn's events.
export class ReplayDataSource implements DataSource {
  private agents: AgentSummary[] = [];
  private sessions: SessionSummary[] = [];
  private turns = new Map<string, Turn[]>();

  constructor(rawJsonl: string) {
    const lines = rawJsonl.split('\n').filter((l) => l.trim().length > 0);
    const events = lines.map((line, idx) => {
      const parsed = JSON.parse(line) as CockpitEvent;
      // Files recorded before seq existed: file order is the order.
      if (parsed.seq === undefined) parsed.seq = idx + 1;
      return parsed;
    });

    const bySession = new Map<string, CockpitEvent[]>();
    for (const e of events) {
      const id = e.session || 'unknown';
      if (!bySession.has(id)) bySession.set(id, []);
      bySession.get(id)!.push(e);
    }

    // A drop report can be filed under any session and still name another
    // one, or all of them; every session's cost completeness reads all of them.
    const dropReports = events.filter((e) => e.kind === 'events.dropped');

    for (const [id, sessEvents] of bySession) {
      const turns = buildTurns(id, sessEvents);
      this.sessions.push(summarizeSession(id, sessEvents, turns, dropReports));
      this.turns.set(id, turns);
    }

    // Newest activity first.
    this.sessions.sort((a, b) => new Date(b.last).getTime() - new Date(a.last).getTime());
    this.agents = buildAgents(this.sessions);
  }

  async getAgents(): Promise<AgentSummary[]> {
    return this.agents;
  }

  async getSessions(agentId?: string): Promise<SessionSummary[]> {
    if (agentId === undefined) return this.sessions;
    return this.sessions.filter((s) => sessionGroup(s) === agentId);
  }

  async getTurns(sessionId: string): Promise<TurnList> {
    const turns = (this.turns.get(sessionId) ?? []).map(({ detail: _detail, ...row }) => row);
    return { turns };
  }

  async getTurn(sessionId: string, turnId: string): Promise<TurnDetail | null> {
    return this.turns.get(sessionId)?.find((t) => t.id === turnId)?.detail ?? null;
  }
}
