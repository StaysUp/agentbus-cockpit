import { CockpitEvent, ShellRun, Turn } from '../types';

// A command.ran event as a ShellRun; null for any other event.
export function shellRun(e: CockpitEvent): ShellRun | null {
  const c = e.command as Record<string, unknown> | undefined;
  if (e.kind !== 'command.ran' || !c || typeof c.line !== 'string') return null;
  return {
    id: e.id,
    sessionId: e.session,
    time: e.time,
    line: c.line,
    exitCode: typeof c.exit_code === 'number' ? c.exit_code : 0,
    timedOut: c.timed_out === true || undefined,
    stdout: typeof c.stdout === 'string' ? c.stdout : '',
    stderr: typeof c.stderr === 'string' ? c.stderr : '',
    outputBytes: typeof c.output_bytes === 'number' ? c.output_bytes : 0,
    truncated: c.truncated === true || undefined,
    durationMs: typeof c.duration_ms === 'number' ? c.duration_ms : 0,
  };
}

// list with run added once, by id, in time order.
export function addRun(list: ShellRun[] | undefined, run: ShellRun): ShellRun[] {
  const cur = list ?? [];
  if (cur.some((r) => r.id === run.id)) return cur;
  return [...cur, run].sort((a, b) => ms(a.time) - ms(b.time));
}

// The text of a message box that runs a command: what follows "!", or null
// when the text is a message for the agent.
export function bangCommand(text: string): string | null {
  const t = text.trimStart();
  return t.startsWith('!') ? t.slice(1).trim() : null;
}

// Where each command goes in the conversation: after the last turn that
// started before it ended. Index -1 is before the first turn.
export function commandsAfter(turns: Turn[], runs: ShellRun[]): Map<number, ShellRun[]> {
  const out = new Map<number, ShellRun[]>();
  for (const r of runs) {
    let at = -1;
    for (let i = 0; i < turns.length; i++) if (turns[i].startedAt && ms(turns[i].startedAt) <= ms(r.time)) at = i;
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
