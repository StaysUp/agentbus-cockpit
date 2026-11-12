import { CockpitEvent, ShellRun, Turn } from '../types';

// The "!" commands of AgentBus 0.4, read-only: a session from before 0.5 may
// hold their events, and shows them between its turns. 0.5 writes none: a
// "!" message goes to the agent, which runs it with its own shell tool.

// The four kinds of a command's events, oldest to newest state.
export const COMMAND_KINDS = ['command.queued', 'command.started', 'command.ran', 'command.failed'];

const STATE: Record<string, ShellRun['state']> = {
  'command.queued': 'queued',
  'command.started': 'running',
  'command.ran': 'ran',
  'command.failed': 'failed',
};
const RANK: Record<ShellRun['state'], number> = { queued: 0, running: 1, ran: 2, failed: 2 };

// A command event as a ShellRun, in the state that event says; null for any
// other event.
export function shellRun(e: CockpitEvent): ShellRun | null {
  const c = e.command as Record<string, unknown> | undefined;
  const state = STATE[e.kind];
  if (!state || !c || typeof c.id !== 'string' || typeof c.line !== 'string') return null;
  return {
    id: c.id,
    sessionId: e.session,
    state,
    time: e.time,
    line: c.line,
    exitCode: typeof c.exit_code === 'number' ? c.exit_code : 0,
    timedOut: c.timed_out === true || undefined,
    stdout: typeof c.stdout === 'string' ? c.stdout : '',
    stderr: typeof c.stderr === 'string' ? c.stderr : '',
    outputBytes: typeof c.output_bytes === 'number' ? c.output_bytes : 0,
    truncated: c.truncated === true || undefined,
    durationMs: typeof c.duration_ms === 'number' ? c.duration_ms : 0,
    error: typeof e.error === 'string' ? e.error : undefined,
  };
}

// list with run's event added: one entry per command id, placed by when it
// was queued, in the latest state its events say. An event that arrives
// late never takes a command back to an earlier state.
export function addRun(list: ShellRun[] | undefined, run: ShellRun): ShellRun[] {
  const cur = list ?? [];
  const i = cur.findIndex((r) => r.id === run.id);
  const held = i < 0 ? undefined : cur[i];
  let next = held && RANK[run.state] <= RANK[held.state] ? held : { ...run, queuedAt: held?.queuedAt };
  if (run.state === 'queued' && !next.queuedAt) next = { ...next, queuedAt: run.time };
  if (next === held) return cur;
  const out = i < 0 ? [...cur, next] : cur.map((r, k) => (k === i ? next : r));
  return out.sort((a, b) => ms(a.queuedAt ?? a.time) - ms(b.queuedAt ?? b.time));
}

// Where each command goes in the conversation: after the last turn that
// started before it was queued. Index -1 is before the first turn.
export function commandsAfter(turns: Turn[], runs: ShellRun[]): Map<number, ShellRun[]> {
  const out = new Map<number, ShellRun[]>();
  for (const r of runs) {
    const at0 = ms(r.queuedAt ?? r.time);
    let at = -1;
    for (let i = 0; i < turns.length; i++) if (turns[i].startedAt && ms(turns[i].startedAt) <= at0) at = i;
    out.set(at, [...(out.get(at) ?? []), r]);
  }
  return out;
}

// A time as milliseconds: RFC 3339 strings of different precision do not
// sort as text.
function ms(t: string): number {
  const n = Date.parse(t);
  return Number.isNaN(n) ? 0 : n;
}
