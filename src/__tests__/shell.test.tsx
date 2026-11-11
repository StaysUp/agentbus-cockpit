// @vitest-environment jsdom
// "!" commands: a message that starts with "!" runs in the session's copy
// (POST /api/v0/sessions/<id>/commands) instead of going to the agent, and
// shows as a shell entry between the turns. Against a fake client API.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { LiveDataSource } from '../data/LiveDataSource';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { bangCommand, commandsAfter, shellRun } from '../data/shell';
import { buildTurns } from '../data/turns';
import { CockpitEvent, DataSource, Turn } from '../types';
import { click, ev, flush, jsonl, render } from './helpers';
import { SHELL_FOLD_LINES } from '../components/ShellEntry';

const BASE = 'http://cockpit.test';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const row = {
  id: 's1',
  agent: 'claude',
  folder: '/w',
  started: '2026-11-05T09:00:00Z',
  last: '2026-11-05T09:10:00Z',
  open: false,
  resumable: true,
  turns: 1,
  usage: { input_tokens: 1, output_tokens: 1 },
};

// One finished turn.
function finishedTurn(): CockpitEvent[] {
  return [
    ev({ kind: 'session.opened', turn: 'T1', hold: 'h1' }),
    ev({ kind: 'turn.started', turn: 'T1', text: 'hello', agent: 'claude', folder: '/w' }),
    ev({ kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
    ev({ kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: 'hi there' }),
    ev({ kind: 'session.closed', turn: 'T1', hold: 'h1', exit_code: 0 }),
  ];
}

// A command event of id, kind queued, started, ran or failed.
function cmdEvent(kind: string, id: string, line: string, fields: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): CockpitEvent {
  return ev({ kind: `command.${kind}`, command: { id, line, ...fields }, ...extra });
}
function ran(line: string, fields: Record<string, unknown> = {}, id = `cmd_${line.replace(/\W/g, '')}`): CockpitEvent {
  return cmdEvent('ran', id, line, { duration_ms: 12, ...fields });
}

function apiTurns(events: CockpitEvent[]) {
  return buildTurns('s1', events)
    .filter((t) => t.detail!.events.some((e) => e.kind === 'turn.started'))
    .map((t) => ({
      id: t.id,
      session: 's1',
      agent: t.agent ?? '',
      folder: t.folder ?? '',
      prompt: t.detail!.rawPrompt ?? '',
      started_seq: t.startedSeq!,
      started: t.startedAt,
      ended: t.endedAt,
      state: t.state,
      usage: t.usage,
      cost_usd: 0,
    }))
    .reverse();
}

function fakeService(opts: { events: CockpitEvent[]; command?: (line: string) => Response }) {
  let nextID = 0;
  const reqs: { method: string; path: string; body?: string }[] = [];
  const enc = new TextEncoder();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let seq = 0;
  for (const e of opts.events) e.seq = ++seq;
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const p = url.pathname;
    reqs.push({ method, path: p + url.search, body: init?.body as string | undefined });
    if (p === '/api/v0/sessions') return json({ store: 'st_1', seq, sessions: [row] });
    if (p === '/api/v0/turns' && method === 'GET') return json({ store: 'st_1', seq, turns: apiTurns(opts.events), next_before: null });
    if (p === '/api/v0/sessions/s1/commands' && method === 'POST') {
      const { command } = JSON.parse(init!.body as string);
      return opts.command ? opts.command(command) : json({ session: 's1', command: `cmd_${++nextID}`, state: 'queued' }, 202);
    }
    if (p === '/api/v0/sessions/s1/events') {
      const kinds = url.searchParams.get('kind')?.split(',');
      const turn = url.searchParams.get('turn');
      const list = opts.events.filter((e) => (kinds ? kinds.includes(e.kind) : turn ? e.turn === turn : true));
      return json({ store: 'st_1', events: list, next_after: null });
    }
    if (p === '/api/v0/events') {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          streams.push(c);
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return json({ error: 'not found' }, 404);
  });
  const push = async (e: CockpitEvent) => {
    e.seq = ++seq;
    opts.events.push(e);
    await act(async () => {
      for (const c of streams) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
    });
  };
  return { fn, reqs, push };
}

async function settle() {
  for (let i = 0; i < 6; i++) await flush();
}

async function mount(svc: ReturnType<typeof fakeService>) {
  vi.stubGlobal('fetch', svc.fn);
  const r = await render(<App dataSource={new LiveDataSource({ baseUrl: BASE, token: 't' })} />);
  await settle();
  return r;
}

async function type(r: { container: HTMLElement }, value: string) {
  const ta = r.container.querySelector('#input') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const goBtn = (r: { container: HTMLElement }) => r.container.querySelector('#c-reply button.go') as HTMLButtonElement;
const shells = (r: { container: HTMLElement }) => [...r.container.querySelectorAll('#convo .shell')] as HTMLElement[];
const posts = (svc: ReturnType<typeof fakeService>, path: string) => svc.reqs.filter((q) => q.method === 'POST' && q.path === path);

afterEach(() => {
  vi.unstubAllGlobals();
});

const state = (el: Element) => el.getAttribute('data-state');

describe('A "!" message', () => {
  it('reads Run, is queued as a command instead of a message, then shows running and its result from events', async () => {
    const svc = fakeService({ events: finishedTurn() });
    const r = await mount(svc);
    expect(goBtn(r).textContent).toBe('Send');
    await type(r, '!ls -la');
    expect(goBtn(r).textContent).toBe('Run');
    await type(r, 'hello');
    expect(goBtn(r).textContent).toBe('Send');
    await type(r, '  ! ls -la');
    await click(goBtn(r));
    await settle();
    expect(posts(svc, '/api/v0/turns')).toHaveLength(0);
    const sent = posts(svc, '/api/v0/sessions/s1/commands');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body!)).toEqual({ command: 'ls -la' });
    let [entry] = shells(r);
    expect(entry.querySelector('.sh-line')?.textContent).toBe('$ ls -la');
    expect(state(entry)).toBe('queued');
    expect(entry.querySelector('.sh-exit')?.textContent).toBe('queued');
    // After the turn's block, in the conversation.
    expect(entry.previousElementSibling?.classList.contains('tb')).toBe(true);
    expect((r.container.querySelector('#input') as HTMLTextAreaElement).value).toBe('');

    await svc.push(cmdEvent('queued', 'cmd_1', 'ls -la'));
    await svc.push(cmdEvent('started', 'cmd_1', 'ls -la'));
    await settle();
    [entry] = shells(r);
    expect(shells(r)).toHaveLength(1);
    expect(entry.querySelector('.sh-exit')?.textContent).toBe('running…');
    await svc.push(ran('ls -la', { stdout: 'a\nb\n' }, 'cmd_1'));
    await settle();
    [entry] = shells(r);
    expect(state(entry)).toBe('ran');
    expect(entry.querySelector('.sh-exit')?.textContent).toBe('exit 0');
    expect(entry.querySelector('.sh-exit')?.classList.contains('ok')).toBe(true);
    expect(entry.querySelector('.sh-out')?.textContent).toBe('a\nb');
    // A late started event does not take it back.
    await svc.push(cmdEvent('started', 'cmd_1', 'ls -la'));
    await settle();
    expect(state(shells(r)[0])).toBe('ran');
    r.unmount();
  });

  it('shows a failed exit, stderr after stdout, and folds long output', async () => {
    const out = Array.from({ length: SHELL_FOLD_LINES + 8 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const svc = fakeService({ events: finishedTurn() });
    const r = await mount(svc);
    await type(r, '!make');
    await click(goBtn(r));
    await settle();
    await svc.push(ran('make', { exit_code: 2, stdout: out, stderr: 'oops\n', output_bytes: 300000, truncated: true }, 'cmd_1'));
    await settle();
    const [entry] = shells(r);
    expect(entry.querySelector('.sh-exit')?.textContent).toBe('exit 2');
    expect(entry.querySelector('.sh-exit')?.classList.contains('bad')).toBe(true);
    expect(entry.querySelector('.sh-out')?.textContent?.split('\n')).toHaveLength(SHELL_FOLD_LINES);
    expect(entry.querySelector('.sh-note')?.textContent).toBe('Output cut at 64 KiB of 300000 bytes.');
    const fold = entry.querySelector('.sh-fold')!;
    expect(fold.textContent).toBe(`Show all ${SHELL_FOLD_LINES + 9} lines`);
    await click(fold);
    expect(entry.querySelector('.sh-out')?.textContent?.endsWith('line 20\noops')).toBe(true);
    expect(entry.querySelector('.sh-fold')?.textContent).toBe('Show less');
    r.unmount();
  });

  it('shows why a command did not run', async () => {
    const svc = fakeService({ events: finishedTurn() });
    const r = await mount(svc);
    await type(r, '!ls');
    await click(goBtn(r));
    await settle();
    await svc.push(cmdEvent('failed', 'cmd_1', 'ls', {}, { error: "the session's runner stopped answering while the command ran" }));
    await settle();
    const [entry] = shells(r);
    expect(state(entry)).toBe('failed');
    expect(entry.querySelector('.sh-exit')?.textContent).toBe('did not run');
    expect(entry.querySelector('.form-error')?.textContent).toBe("the session's runner stopped answering while the command ran");
    r.unmount();
  });

  it('shows the API words when refused, and Edit puts the command back', async () => {
    const svc = fakeService({
      events: finishedTurn(),
      command: () => json({ error: 'this session is closed; it runs no more commands' }, 409),
    });
    const r = await mount(svc);
    await type(r, '!ls');
    await click(goBtn(r));
    await settle();
    const [entry] = shells(r);
    expect(entry.classList.contains('failed')).toBe(true);
    expect(entry.querySelector('.form-error')?.textContent).toBe('this session is closed; it runs no more commands');
    await click(entry.querySelector('.pend-back'));
    expect((r.container.querySelector('#input') as HTMLTextAreaElement).value).toBe('!ls');
    expect(shells(r)).toHaveLength(0);
    r.unmount();
  });

  it('a bare "!" runs nothing', async () => {
    const svc = fakeService({ events: finishedTurn() });
    const r = await mount(svc);
    await type(r, '!  ');
    expect(goBtn(r).textContent).toBe('Run');
    expect(goBtn(r).disabled).toBe(true);
    r.unmount();
  });
});

describe('Commands already run', () => {
  it('are read on load by their four kinds, placed between turns, one entry each', async () => {
    const events = finishedTurn();
    events.push(cmdEvent('queued', 'cmd_9', 'git status'), cmdEvent('started', 'cmd_9', 'git status'), ran('git status', { stdout: 'clean\n' }, 'cmd_9'));
    events.push(cmdEvent('queued', 'cmd_10', 'sleep 9'));
    const svc = fakeService({ events });
    const r = await mount(svc);
    expect(
      svc.reqs.some((q) => q.path === '/api/v0/sessions/s1/events?kind=command.queued%2Ccommand.started%2Ccommand.ran%2Ccommand.failed&limit=1000')
    ).toBe(true);
    expect(shells(r).map((s) => [s.querySelector('.sh-line')?.textContent, state(s)])).toEqual([
      ['$ git status', 'ran'],
      ['$ sleep 9', 'queued'],
    ]);
    r.unmount();
  });

  it('are not offered for recorded data', async () => {
    const replay = new ReplayDataSource(jsonl(finishedTurn()));
    expect((replay as DataSource).runCommand).toBeUndefined();
    const r = await render(<App dataSource={replay} />);
    await settle();
    expect(shells(r)).toHaveLength(0);
    r.unmount();
  });
});

describe('shell helpers', () => {
  it('bangCommand takes what follows "!"', () => {
    expect(bangCommand('!ls')).toBe('ls');
    expect(bangCommand('  ! git status ')).toBe('git status');
    expect(bangCommand('hello !ls')).toBeNull();
    expect(bangCommand('!')).toBe('');
  });

  it('shellRun reads the command kinds and nothing else', () => {
    expect(shellRun(ev({ kind: 'turn.started' }))).toBeNull();
    const r = shellRun(ran('ls', { exit_code: 1, timed_out: true }, 'cmd_1'))!;
    expect(r.id).toBe('cmd_1');
    expect(r.state).toBe('ran');
    expect(r.exitCode).toBe(1);
    expect(r.timedOut).toBe(true);
    expect(shellRun(cmdEvent('started', 'cmd_1', 'ls'))!.state).toBe('running');
  });

  it('commandsAfter places each command after the last turn that started before it, by time', () => {
    const t = (id: string, startedAt: string) => ({ id, startedAt }) as Turn;
    const turns = [t('T1', '2026-11-05T09:00:00Z'), t('T2', '2026-11-05T09:00:10Z')];
    const at = (time: string) => ({ ...shellRun(ran('x'))!, time, queuedAt: time });
    const placed = commandsAfter(turns, [at('2026-11-05T08:59:59Z'), at('2026-11-05T09:00:05.5Z'), at('2026-11-05T09:00:10.25Z')]);
    expect(placed.get(-1)).toHaveLength(1);
    expect(placed.get(0)).toHaveLength(1);
    expect(placed.get(1)).toHaveLength(1);
  });
});
