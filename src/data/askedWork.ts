// Work a session asked another agent for (ask_agent, review_turn), while it
// waits and while it runs. Read from what the cockpit already holds: the asked
// session's row (GET /api/v0/sessions: origin asked, open) and its turns on
// the turn list (GET /api/v0/turns, read every few seconds), which carries a
// queued turn before any event of it is recorded. Nothing new is asked of the
// service.
import { CockpitEvent, SessionSummary } from '../types';
import { ApiTurn } from './jobs';
import { pairToolCalls } from './turns';
import { formatElapsed, RUNNER_WAIT_MS, steadyNow } from './liveStatus';

export interface AskedWork {
  // The asked session.
  id: string;
  // The saved agent (or harness) doing the work.
  agent?: string;
  // The turn that asked for it.
  by?: string;
  state: 'queued' | 'running';
  // When the work started running (ms), when the turn list says.
  sinceMs?: number;
}

// The work `session` asked for that is queued or running, oldest first. A
// session that ended (its turn finished, failed or stopped, or ran and closed)
// is left out: its result comes back as a turn of the asking session.
export function askedWork(sessions: SessionSummary[], session: string, turnsOf?: (session: string) => ApiTurn[]): AskedWork[] {
  const out: AskedWork[] = [];
  for (const s of sessions) {
    if (s.origin?.kind !== 'asked' || s.origin.session !== session) continue;
    const turns = turnsOf?.(s.id) ?? [];
    const running = turns.find((t) => t.state === 'running');
    const base = { id: s.id, agent: s.first_agent_id ?? running?.agent_id ?? turns[0]?.agent_id ?? s.agent, by: s.origin.turn };
    if (running || s.open) {
      const at = running?.started ? Date.parse(running.started) : NaN;
      out.push({ ...base, state: 'running', sinceMs: isNaN(at) ? undefined : at });
    } else if (turns.some((t) => t.state === 'queued')) {
      out.push({ ...base, state: 'queued' });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// True when the asking turn's events show the ask as a review: the tool call
// whose result names the asked session is review_turn (the agentbus app; a
// harness may prefix it, as claude's mcp__agentbus__review_turn).
export function askedReview(events: CockpitEvent[] | undefined, asked: string): boolean {
  if (!events) return false;
  for (const p of pairToolCalls(events, events)) {
    const out = p.completed?.tool_output;
    const text = typeof out === 'string' ? out : out === undefined ? '' : JSON.stringify(out);
    if (text.includes(asked)) return /review_turn$/.test(p.requested.tool_name ?? '');
  }
  return false;
}

// When the cockpit first saw each piece of asked work queued, on the steady
// local clock. Kept for the page's life, so a switch away and back does not
// start the wait over.
const firstQueued = new Map<string, number>();

// Forgets every wait counted so far (tests).
export function resetQueuedWaits(): void {
  firstQueued.clear();
}

// How long the cockpit has seen asked work `id` queued (ms). The first call
// starts the count.
export function queuedWaitMs(id: string, at = steadyNow()): number {
  let since = firstQueued.get(id);
  if (since === undefined) {
    since = at;
    firstQueued.set(id, since);
  }
  return at - since;
}

// The status line for one piece of asked work, in plain words:
// "Codex review queued · starts when this turn ends",
// "Codex is reviewing · 2m 5s", "Codex is working on it · 40s".
// Queued behind nothing, it waits like a sent message: "Waiting for Codex"
// until it has been queued RUNNER_WAIT_MS (waitedMs), then "Codex queued ·
// waiting for a runner". With no waitedMs it names the runner at once.
export function askedLine(w: AskedWork, name: string, review: boolean, askerRunning: boolean, now: number, waitedMs?: number): string {
  if (w.state === 'queued') {
    if (askerRunning) return `${name}${review ? ' review' : ''} queued · starts when this turn ends`;
    if (waitedMs !== undefined && waitedMs < RUNNER_WAIT_MS) return review ? `Waiting for the ${name} review` : `Waiting for ${name}`;
    return `${name}${review ? ' review' : ''} queued · waiting for a runner`;
  }
  const what = `${name} ${review ? 'is reviewing' : 'is working on it'}`;
  return w.sinceMs !== undefined ? `${what} · ${formatElapsed(now - w.sinceMs)}` : what;
}
