// @vitest-environment jsdom
// "!" commands. Since AgentBus 0.5 a message that starts with "!" is an
// ordinary message to the session's agent, which runs the command with its
// own shell tool. The "!" commands of 0.4 (command.* events) a session may
// still hold show read-only, as shell entries between the turns. Against a
// fake client API.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { LiveDataSource } from '../data/LiveDataSource';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { commandsAfter, shellRun } from '../data/shell';
import { buildTurns } from '../data/turns';
import { CockpitEvent, DataSource, Turn } from '../types';
import { click, ev, flush, jsonl, render } from './helpers';
import { SHELL_FOLD_LINES } from '../components/ShellEntry';
import { STREAM_HIDDEN_MS, useTabShown } from '../data/useTabShown';

const BASE = 'http://cockpit.test';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
// A settings route's answer: JSON with the ETag every settings read carries.
function tagged(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ETag: '"1"' } });
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

// settingsCreated: when the settings database was made (GET /api/v0/settings);
// absent, that route answers 404 as a service before 0.5 does.
function fakeService(opts: { events: CockpitEvent[]; settingsCreated?: string }) {
  const reqs: { method: string; path: string; body?: string }[] = [];
  const enc = new TextEncoder();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const signals: AbortSignal[] = [];
  let seq = 0;
  for (const e of opts.events) e.seq = ++seq;
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const p = url.pathname;
    reqs.push({ method, path: p + url.search, body: init?.body as string | undefined });
    if (p === '/api/v0/sessions') return json({ store: 'st_1', seq, sessions: [row] });
    if (p === '/api/v0/settings' && opts.settingsCreated) return tagged({ version: 1, created: opts.settingsCreated, imported_files: [] });
    if (p === '/api/v0/turns' && method === 'GET') return json({ store: 'st_1', seq, turns: apiTurns(opts.events), next_before: null });
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
          if (init?.signal) signals.push(init.signal);
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
  // The event streams still open.
  const openStreams = () => signals.filter((x) => !x.aborted).length;
  return { fn, reqs, push, openStreams };
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
  it('is sent to the agent as an ordinary message: Send, no Run, no command route', async () => {
    const svc = fakeService({ events: finishedTurn() });
    const r = await mount(svc);
    await type(r, '!ls -la');
    expect(goBtn(r).textContent).toBe('Send');
    expect(goBtn(r).disabled).toBe(false);
    expect((r.container.querySelector('#input') as HTMLTextAreaElement).placeholder).not.toContain('!');
    await click(goBtn(r));
    await settle();
    expect(svc.reqs.some((q) => q.path.includes('/commands'))).toBe(false);
    const sent = posts(svc, '/api/v0/turns');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body!)).toMatchObject({ session: 's1', prompt: '!ls -la' });
    expect(shells(r)).toHaveLength(0);
    r.unmount();
  });

  it('a bare "!" is a message too', async () => {
    const svc = fakeService({ events: finishedTurn() });
    const r = await mount(svc);
    await type(r, '!');
    expect(goBtn(r).textContent).toBe('Send');
    expect(goBtn(r).disabled).toBe(false);
    r.unmount();
  });
});

describe('Commands from before 0.5', () => {
  it('are read on load by their four kinds, placed between turns, one entry each, read-only', async () => {
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
    const [done, open] = shells(r);
    // After the turn's block, in the conversation.
    expect(done.previousElementSibling?.classList.contains('tb')).toBe(true);
    expect(done.querySelector('.sh-exit')?.textContent).toBe('exit 0');
    expect(done.querySelector('.sh-exit')?.classList.contains('ok')).toBe(true);
    expect(done.querySelector('.sh-out')?.textContent).toBe('clean');
    // One with no end in the record gets none now: 0.5 runs no such command.
    expect(open.querySelector('.sh-exit')?.textContent).toBe('no end recorded');
    expect(r.container.querySelectorAll('#convo .shell button:not(.sh-fold)')).toHaveLength(0);
    r.unmount();
  });

  it('show a failed exit, stderr after stdout, and fold long output', async () => {
    const out = Array.from({ length: SHELL_FOLD_LINES + 8 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const events = finishedTurn();
    events.push(ran('make', { exit_code: 2, stdout: out, stderr: 'oops\n', output_bytes: 300000, truncated: true }, 'cmd_1'));
    const r = await mount(fakeService({ events }));
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

  it('show why a command did not run', async () => {
    const events = finishedTurn();
    events.push(cmdEvent('failed', 'cmd_1', 'ls', {}, { error: "the session's runner stopped answering while the command ran" }));
    const r = await mount(fakeService({ events }));
    const [entry] = shells(r);
    expect(state(entry)).toBe('failed');
    expect(entry.querySelector('.sh-exit')?.textContent).toBe('did not run');
    expect(entry.querySelector('.form-error')?.textContent).toBe("the session's runner stopped answering while the command ran");
    r.unmount();
  });

  it('are not read from recorded data', async () => {
    const replay = new ReplayDataSource(jsonl(finishedTurn()));
    expect((replay as DataSource).getCommands).toBeUndefined();
    const r = await render(<App dataSource={replay} />);
    await settle();
    expect(shells(r)).toHaveLength(0);
    r.unmount();
  });
});

describe('Commands are asked for only where a session can hold them', () => {
  const kindsAsked = (svc: ReturnType<typeof fakeService>) => svc.reqs.filter((q) => q.path.includes('kind=command.'));
  const withCommand = () => {
    const events = finishedTurn();
    events.push(cmdEvent('queued', 'cmd_9', 'git status'), ran('git status', { stdout: 'clean\n' }, 'cmd_9'));
    return events;
  };

  it('not for a session that started after this control first ran 0.5', async () => {
    // The session started 2026-11-05; the settings database is from before.
    const svc = fakeService({ events: withCommand(), settingsCreated: '2026-11-01T00:00:00Z' });
    const r = await mount(svc);
    expect(svc.reqs.some((q) => q.path === '/api/v0/settings')).toBe(true);
    expect(kindsAsked(svc)).toHaveLength(0);
    expect(shells(r)).toHaveLength(0);
    r.unmount();
  });

  it('for a session that started before it, and shows them as before', async () => {
    const svc = fakeService({ events: withCommand(), settingsCreated: '2026-11-10T00:00:00Z' });
    const r = await mount(svc);
    expect(kindsAsked(svc)).toHaveLength(1);
    expect(shells(r).map((x) => x.querySelector('.sh-line')?.textContent)).toEqual(['$ git status']);
    r.unmount();
  });
});

describe('The event stream', () => {
  const setHidden = async (hidden: boolean) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  };
  afterEach(() => {
    // Back to jsdom's own.
    delete (document as unknown as Record<string, unknown>).visibilityState;
    window.history.replaceState(null, '', '/');
  });

  it('is given back only after the tab stays hidden a while, and taken again once it is shown', async () => {
    vi.useFakeTimers();
    try {
      let shown: boolean | undefined;
      const Probe = () => {
        shown = useTabShown();
        return null;
      };
      const r = await render(<Probe />);
      expect(shown).toBe(true);
      // A quick look at another tab keeps it.
      await setHidden(true);
      await act(async () => {
        vi.advanceTimersByTime(STREAM_HIDDEN_MS - 1);
      });
      expect(shown).toBe(true);
      await setHidden(false);
      await act(async () => {
        vi.advanceTimersByTime(STREAM_HIDDEN_MS * 2);
      });
      expect(shown).toBe(true);
      // Left hidden, it goes; shown, it comes back at once.
      await setHidden(true);
      await act(async () => {
        vi.advanceTimersByTime(STREAM_HIDDEN_MS);
      });
      expect(shown).toBe(false);
      await setHidden(false);
      expect(shown).toBe(true);
      r.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not held by a tab opened hidden, and opens once the tab is shown', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const svc = fakeService({ events: finishedTurn() });
    const r = await mount(svc);
    expect(svc.openStreams()).toBe(0);
    await setHidden(false);
    await settle();
    expect(svc.openStreams()).toBe(1);
    // The list came with the stream's snapshot.
    expect(r.container.querySelector('.sess[data-session="s1"]')).not.toBeNull();
    r.unmount();
  });

  it('is given back on the Settings page, and opens again back in the cockpit', async () => {
    const svc = fakeService({ events: finishedTurn() });
    // The settings routes, so the page shows.
    const base = svc.fn.getMockImplementation()!;
    svc.fn.mockImplementation(async (input: string, init?: RequestInit) => {
      const p = new URL(input).pathname;
      if (p === '/api/v0/settings') return tagged({ version: 1, created: '2026-11-01T00:00:00Z', imported_files: [] });
      if (p === '/api/v0/settings/permissions') return tagged({ sandbox: { mode: 'off' }, home_files: [] });
      if (p === '/api/v0/settings/instructions') return tagged({ text: '' });
      return base(input, init);
    });
    const r = await mount(svc);
    expect(svc.openStreams()).toBe(1);
    const follow = async (text: string) => {
      const a = [...r.container.querySelectorAll('a')].find((x) => x.textContent?.trim() === text);
      await act(async () => {
        a!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      });
      await settle();
    };
    await follow('Settings');
    expect(r.container.querySelector('#page[aria-label="Settings"]')).not.toBeNull();
    expect(r.container.querySelector('table[aria-label="Grants"]')).not.toBeNull();
    expect(svc.openStreams()).toBe(0);
    await follow('Cockpit');
    expect(svc.openStreams()).toBe(1);
    r.unmount();
  });
});

describe('shell helpers', () => {
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
