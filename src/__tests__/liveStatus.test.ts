// The live status of a turn, against real gateway recordings of 2026-11-07
// (testdata/live-turns-2026-11-07.jsonl): four runs through a fresh
// `agentbus up`, each status read at moments taken from their own timings.
//   claude A: Read hello.py, then Edit and Bash from one reply, exit 0.
//   codex B:  one exec script running `sleep 6; ls no_such_file` (exit 1).
//   claude B: Bash `sleep 6; ls no_such_file`, tool_error "Exit code 1".
//   codex A:  exec (two exec_command steps), exec (apply_patch + command).
import { describe, expect, it, beforeEach } from 'vitest';
import raw from '../../testdata/live-turns-2026-11-07.jsonl?raw';
import { codexExits, eventsNow, formatElapsed, liveStatus, noteEventTime, resetClock, shortPath, toolGroups, toolResult } from '../data/liveStatus';
import { turnDetail } from '../data/turns';
import { CockpitEvent } from '../types';

const all: CockpitEvent[] = raw
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const TURNS = {
  claudeA: 't_b230d16a85658ec2',
  codexB: 't_e70c27064a2477aa',
  claudeB: 't_67862f4cf5b6b276',
  codexA: 't_54f6f60868721cb6',
};
const of = (turn: string) => all.filter((e) => e.turn === turn);
const t0 = (events: CockpitEvent[]) => Date.parse(events.find((e) => e.kind === 'turn.started')!.time);
// The events received up to `sec` seconds after the turn started.
const upTo = (events: CockpitEvent[], sec: number) => events.filter((e) => Date.parse(e.time) <= t0(events) + sec * 1000);
// The line at `sec` seconds after the start, from the events seen by then.
const at = (turn: string, sec: number) => {
  const events = of(turn);
  return liveStatus(upTo(events, sec), t0(events) + sec * 1000);
};

describe('liveStatus, claude turn A (Read, then Edit + Bash from one reply)', () => {
  const T = TURNS.claudeA;
  it('reads each step at its own moment', () => {
    // 0.0 turn.started; 3.07 call 1; 6.59 reply + Read; 6.68 Read done, call 2;
    // 11.25 reply + Edit + Bash; 14.65 both done, call 3; 17.52 reply,
    // turn.completed; 18.16 session.closed exit 0.
    expect(at(T, 2).line).toBe('Starting claude · 2s');
    expect(at(T, 2).state).toBe('starting');
    expect(at(T, 5).line).toBe('Waiting on the model · call 1 · 1s');
    expect(at(T, 6.6).line).toBe('Reading hello.py · 0s');
    expect(at(T, 9).line).toBe('Waiting on the model · call 2 · 2s');
    expect(at(T, 13).line).toBe('2 tools running · 1s');
    expect(at(T, 16).line).toBe('Waiting on the model · call 3 · 1s');
    expect(at(T, 16).call).toBe(3);
    expect(at(T, 17.8).line).toBe('Finishing · 0s');
    expect(at(T, 17.8).running).toBe(true);
    const end = at(T, 30);
    expect(end.state).toBe('finished');
    expect(end.running).toBe(false);
    expect(end.line).toBe('Finished · 18s · $0.28');
  });

  it('counts cost once per call, with the last call as the delta', () => {
    const s1 = at(T, 7);
    expect(s1.costUsd).toBeCloseTo(0.2319, 4);
    expect(s1.lastDeltaUsd).toBeCloseTo(0.2319, 4);
    const s2 = at(T, 12);
    expect(s2.costUsd).toBeCloseTo(0.2673, 4);
    expect(s2.lastDeltaUsd).toBeCloseTo(0.0354, 4);
    expect(s2.lastDeltaId).not.toBe(s1.lastDeltaId);
    // Inside a call it never moves.
    expect(at(T, 13.9).costUsd).toBe(s2.costUsd);
    expect(at(T, 2).costUsd).toBeNull();
  });

  it('shows the Edit as a diff and gives the two tools of one reply one time', () => {
    const groups = toolGroups(turnDetail(of(T)), '/tmp/livestatus.k5YMqL/projA');
    expect(groups.map((g) => g.tools.map((t) => t.label))).toEqual([['Read'], ['Edit', 'Run']]);
    expect(groups.map((g) => g.call)).toEqual([1, 2]);
    const [read, edit, run] = [groups[0].tools[0], ...groups[1].tools];
    expect(read.target).toBe('hello.py');
    expect(read.result?.text).toBe('ok');
    expect(edit.target).toBe('hello.py');
    expect(edit.diff).toEqual({ del: ['"hello " + name'], add: ['"hi " + name'] });
    // The leading cd into the turn's folder is left out.
    expect(run.target).toBe('python3 hello.py && sleep 3 && ls');
    expect(run.result?.text).toBe('ok');
    expect(formatElapsed(groups[1].endedMs! - groups[1].startedMs)).toBe('3s');
    expect(groups[1].endedMs! - groups[1].startedMs).toBeGreaterThan(3300);
  });

  it('while the tools run, the group has no end yet', () => {
    const groups = toolGroups(turnDetail(upTo(of(T), 13)), '/tmp/livestatus.k5YMqL/projA');
    expect(groups[1].endedMs).toBeUndefined();
    expect(groups[1].tools.every((t) => t.result === undefined)).toBe(true);
  });
});

describe('liveStatus, claude turn B (Bash exits 1)', () => {
  const T = TURNS.claudeB;
  it('names the command while it runs, and the exit after', () => {
    // 1.95 call 1; 6.17 Bash; 13.29 Bash result (tool_error, Exit code 1).
    expect(at(T, 9).line).toBe('Running sleep 6; ls no_such_file · 2s');
    const [g] = toolGroups(turnDetail(of(T)));
    const run = g.tools[0];
    expect(run.result).toEqual({ text: 'exit 1', failed: true, exitCode: 1, why: 'ls: no_such_file: No such file or directory' });
    expect((run.endedMs! - run.startedMs) / 1000).toBeCloseTo(7.1, 1);
    // The agent itself ends well: the turn finished.
    expect(at(T, 40).line).toBe('Finished · 21s · $0.26');
  });
});

describe('liveStatus, codex turn B (exec script, exit 1 inside its output)', () => {
  const T = TURNS.codexB;
  it('shows the script as code and reads the exit code from its output', () => {
    // 2.88 call 1; 6.64 exec; 12.95 exec result, call 2; 17.27 reply and
    // turn.completed; 20.36 session.closed.
    expect(at(T, 1).line).toBe('Starting codex · 1s');
    expect(at(T, 8).line).toBe('Running exec · 1s');
    expect(at(T, 14).line).toBe('Waiting on the model · call 2 · 1s');
    expect(at(T, 19).line).toBe('Finishing · 1s');
    const [g] = toolGroups(turnDetail(of(T)));
    const card = g.tools[0];
    expect(card.label).toBe('exec');
    expect(card.script).toContain('tools.exec_command({cmd:"sleep 6; ls no_such_file"');
    expect(card.result).toEqual({ text: 'exit 1', failed: true, exitCode: 1, why: 'ls: no_such_file: No such file or directory' });
  });
});

describe('liveStatus, codex turn A (two scripts, every step exit 0)', () => {
  const T = TURNS.codexA;
  it('reads each step result in a script, and the long finish', () => {
    const groups = toolGroups(turnDetail(of(T)));
    expect(groups.map((g) => g.tools[0].result?.text)).toEqual(['ok', 'ok']);
    // turn.completed 17.92, session.closed 30.02: codex ends slowly.
    expect(at(T, 25).line).toBe('Finishing · 7s');
    expect(at(T, 40).line).toBe('Finished · 30s · $0.02');
  });
});

describe('codexExits', () => {
  it('the why line is the last line printed, after the command\'s own output', () => {
    const req = { id: 'r', kind: 'tool.requested', time: '', session: 's', tool_name: 'Bash', tool_input: { command: 'x' } } as CockpitEvent;
    const done = { id: 'd', kind: 'tool.completed', time: '', session: 's', tool_error: true,
      tool_output: 'Exit code 1\nhi world\nls: no_such_file: No such file or directory' } as CockpitEvent;
    expect(toolResult(req, done).why).toBe('ls: no_such_file: No such file or directory');
  });
  it('reads JSON objects that follow each other, and none inside a step output', () => {
    const out =
      'Script completed\nWall time 0.3 seconds\nOutput:\n{"chunk_id":"a","exit_code":0,"output":"{\\"exit_code\\":9}\\n"}{"chunk_id":"b","exit_code":2,"output":"x\\n"}';
    expect(codexExits(out)).toEqual([
      { code: 0, output: '{"exit_code":9}\n' },
      { code: 2, output: 'x\n' },
    ]);
  });
  it('ignores an empty object, text with braces, and an unclosed one', () => {
    expect(codexExits('Output:\n{}{"chunk_id":"c","exit_code":0}')).toEqual([{ code: 0, output: undefined }]);
    expect(codexExits('a { b } c {"exit_code": 3')).toEqual([]);
    expect(codexExits('no json here')).toEqual([]);
  });
  it('falls back to "done" when no exit code can be read', () => {
    const req = { id: 'r', kind: 'tool.requested', time: '', session: 's', tool_name: 'exec', tool_input: 'x' } as CockpitEvent;
    const done = { id: 'd', kind: 'tool.completed', time: '', session: 's', tool_output: 'Script completed\nOutput:\nhello' } as CockpitEvent;
    expect(toolResult(req, done)).toEqual({ text: 'done', failed: false });
  });
});

describe('liveStatus, how a run ends', () => {
  const base = (extra: Partial<CockpitEvent>[]): CockpitEvent[] =>
    [
      { kind: 'session.opened', time: '2026-11-07T10:00:00Z' },
      { kind: 'turn.started', time: '2026-11-07T10:00:00Z', agent: 'claude' },
      { kind: 'model.requested', time: '2026-11-07T10:00:03Z', exchange: 'x1' },
      ...extra,
    ].map((e, i) => ({ id: `e${i}`, session: 's', turn: 't', ...e }) as CockpitEvent);
  const now = Date.parse('2026-11-07T10:01:00Z');

  it('stopped', () => {
    const s = liveStatus(base([{ kind: 'session.closed', time: '2026-11-07T10:00:09Z', exit_code: 143, stopped: true }]), now);
    expect(s.state).toBe('stopped');
    expect(s.line).toBe('Stopped · 9s');
  });
  it('failed on its exit code, or on a failed call', () => {
    expect(liveStatus(base([{ kind: 'session.closed', time: '2026-11-07T10:00:14Z', exit_code: 2 }]), now).line).toBe(
      'Failed · the agent exited 2 · 14s'
    );
    const s = liveStatus(
      base([
        { kind: 'model.responded', time: '2026-11-07T10:00:05Z', exchange: 'x1', status: 529 },
        { kind: 'session.closed', time: '2026-11-07T10:00:06Z', exit_code: 1 },
      ]),
      now
    );
    expect(s.line).toBe('Failed · call 1 returned 529 · 6s');
  });
  it('a probe call is never a step', () => {
    const s = liveStatus(base([{ kind: 'model.requested', time: '2026-11-07T10:00:04Z', exchange: 'p', probe: true }]), Date.parse('2026-11-07T10:00:05Z'));
    expect(s.line).toBe('Waiting on the model · call 1 · 2s');
  });
  it('a turn no run started ends at its turn.completed', () => {
    const events = [
      { id: 'a', kind: 'turn.started', time: '2026-11-07T10:00:00Z', session: 's', turn: 't' },
      { id: 'b', kind: 'turn.completed', time: '2026-11-07T10:00:04Z', session: 's', turn: 't' },
    ] as CockpitEvent[];
    expect(liveStatus(events, now).line).toBe('Finished · 4s');
  });
});

describe('helpers', () => {
  it('formatElapsed', () => {
    expect(formatElapsed(-5)).toBe('0s');
    expect(formatElapsed(59_999)).toBe('59s');
    expect(formatElapsed(65_000)).toBe('1m 5s');
  });
  it('shortPath keeps a path outside the folder whole', () => {
    expect(shortPath('/private/tmp/x/a.py', '/tmp/x')).toBe('a.py');
    expect(shortPath('/etc/hosts', '/tmp/x')).toBe('/etc/hosts');
    expect(shortPath('/tmp/xy/a.py', '/tmp/x')).toBe('/tmp/xy/a.py');
  });
  beforeEach(() => resetClock());
  it('the events clock takes the smallest receive-minus-event gap seen', () => {
    noteEventTime('2026-11-07T10:00:00Z', Date.parse('2026-11-07T10:05:00Z')); // a resent old event
    noteEventTime('2026-11-07T10:06:00Z', Date.parse('2026-11-07T10:06:00.008Z'));
    expect(eventsNow(Date.parse('2026-11-07T10:07:00.008Z'))).toBe(Date.parse('2026-11-07T10:07:00Z'));
  });
});
