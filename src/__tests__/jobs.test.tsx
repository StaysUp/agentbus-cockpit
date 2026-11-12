// @vitest-environment jsdom
// The turn queue: the Review button, Fix, and the CI/CD views of turns and
// their reviews. A fake QueueSource stands in for GET /api/v0/turns and the
// turn actions.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import {
  ApiTurn,
  defaultReviewer,
  fixPrompt,
  probeQueue,
  QueueSource,
  ReviewRequest,
  TurnsClient,
  turnTimes,
} from '../data/jobs';
import { queueView } from '../data/useJobs';
import { CockpitEvent, DataSource } from '../types';
import { choose, click, ev, flush, liveReplay, render, selectIn } from './helpers';

const T0 = '2026-11-08T10:00:00Z';

function row(fields: Partial<ApiTurn> & { id: string }): ApiTurn {
  return {
    session: 's1',
    kind: 'turn',
    agent: 'claude',
    folder: '/w',
    prompt: 'add a file',
    state: 'finished',
    asked: T0,
    started: T0,
    ...fields,
  };
}

function turnEvents(session = 's1', turn = 'T1'): CockpitEvent[] {
  return [
    ev({ session, kind: 'session.registered', agent: 'claude', folder: '/w' }),
    ev({ session, kind: 'turn.started', turn, exchange: 'x1', text: 'add a file', agent: 'claude', folder: '/w' }),
    ev({ session, kind: 'model.requested', turn, exchange: 'x1' }),
    ev({ session, kind: 'model.responded', turn, exchange: 'x1', status: 200, text: 'done', stop_reason: 'end_turn' }),
    ev({ session, kind: 'turn.completed', turn, exchange: 'x1', outcome: 'finished' }),
  ];
}

// The turn list in memory. Tests change `state.turns` and the next read
// (every 10 ms) shows it.
function fakeQueue(initial: ApiTurn[]) {
  const state = { turns: [...initial] };
  const calls = { reviews: [] as [string, ReviewRequest][], stopped: [] as string[] };
  const src: QueueSource = {
    address: 'http://agentbus.test',
    pollMs: 10,
    listTurns: async () => state.turns.slice().reverse(),
    review: async (id, req) => {
      calls.reviews.push([id, req]);
      const n = calls.reviews.length;
      state.turns.push(
        row({
          id: `R${n}`,
          session: `rs${n}`,
          kind: 'review',
          reviews: id,
          state: 'queued',
          agent: req.agent,
          model: req.model,
          prompt: 'review',
          asked: `2026-11-08T10:1${n}:00Z`,
          started: undefined,
        })
      );
      return { session: `rs${n}`, turn: `R${n}`, state: 'queued' };
    },
    stop: async (id) => {
      calls.stopped.push(id);
    },
  };
  const update = (id: string, fields: Partial<ApiTurn>) => {
    state.turns = state.turns.map((t) => (t.id === id ? { ...t, ...fields } : t));
  };
  return { src, state, calls, update };
}

// The replay source, with sessions that take a next message and agents to
// pick from.
function source(events: CockpitEvent[], extra: Partial<DataSource> = {}) {
  const base = liveReplay(events);
  const resumable = <T extends { resumable?: boolean }>(list: T[]) => list.map((s) => ({ ...s, resumable: true }));
  const sendMessage = vi.fn(async (id: string) => ({ session: id, turn: 'Tdirect', state: 'running' as const }));
  const src: DataSource = {
    ...base.source,
    getSessions: async (a) => resumable(await base.source.getSessions(a)),
    subscribe: (cb, snap) => base.source.subscribe!(cb, (list, c) => snap?.(resumable(list), c)),
    getHarnesses: async () => [
      { name: 'claude', found: true },
      { name: 'codex', found: true },
    ],
    listAgents: async () => [
      { id: 'claude', name: 'Claude Code', harness: 'claude', access: 'subscription' },
      { id: 'codex', name: 'Codex', harness: 'codex', access: 'subscription' },
    ],
    startRun: vi.fn(async () => ({ session: 'direct', turn: 'Tdirect', state: 'running' as const })),
    sendMessage,
    ...extra,
  };
  return { src, push: base.push, sendMessage };
}

async function waitFor(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function setValue(el: Element | null, value: string) {
  if (!el) throw new Error('no field');
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

const tabNames = (c: HTMLElement) => Array.from(c.querySelectorAll('#d-tabs .tab')).map((t) => t.textContent);
const bar = (c: HTMLElement) => c.querySelector('.review-bar') as HTMLElement | null;
const ciTab = (c: HTMLElement) => Array.from(c.querySelectorAll('#d-tabs .tab')).find((t) => t.textContent === 'CI/CD');

async function openTurn(c: HTMLElement) {
  await flush();
  await click(c.querySelector('#convo .tb'));
  await flush();
}

const T1 = row({ id: 'T1', ended: '2026-11-08T10:00:12Z' });

// The review screens are off by default (src/features.ts); these tests turn
// them on, except the one that checks the default.
beforeEach(() => {
  vi.stubEnv('VITE_REVIEW_UI', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('without a turn queue', () => {
  it('shows no Review and no CI/CD tab', async () => {
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} />);
    await openTurn(r.container);
    expect(bar(r.container)).toBeNull();
    expect(tabNames(r.container)).not.toContain('CI/CD');
    r.unmount();
  });
});

describe('by default, with a turn queue', () => {
  it('hides Review, Fix, the CI/CD tab and the session turn list', async () => {
    vi.stubEnv('VITE_REVIEW_UI', '');
    const fake = fakeQueue([T1]);
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} queue={fake.src} />);
    await waitFor(() => r.container.querySelector('#convo .tb') !== null, 'the turn');
    await openTurn(r.container);
    expect(bar(r.container)).toBeNull();
    expect(tabNames(r.container)).not.toContain('CI/CD');
    await click(r.container.querySelector('#p-head .crumb[data-level="session"]'));
    await flush();
    expect(r.container.querySelector('.jobs-table')).toBeNull();
    r.unmount();
  });
});

describe('Review', () => {
  it('offers another vendor first, asks for a review by turn id, and shows its verdict and findings', async () => {
    const fake = fakeQueue([T1]);
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} queue={fake.src} />);
    await waitFor(() => r.container.querySelector('#convo .tb') !== null, 'the turn');
    await openTurn(r.container);
    await waitFor(() => bar(r.container) !== null, 'the review bar');
    const select = selectIn(bar(r.container)!, 'reviewer')!;
    expect(select.value).toBe('codex');
    expect(tabNames(r.container)).toContain('CI/CD');

    // Claude can review Claude's turn, and the bar says it is the same vendor.
    await choose(bar(r.container)!, 'reviewer', 'claude');
    expect((bar(r.container)!.querySelector('input[name="reviewer-model"]') as HTMLInputElement).value).toBe('sonnet');
    expect(bar(r.container)!.textContent).toContain('Same vendor as the author.');

    await click(bar(r.container)!.querySelector('.rb-go'));
    await waitFor(() => fake.calls.reviews.length === 1, 'the review call');
    expect(fake.calls.reviews[0]).toEqual(['T1', { agent: 'claude', model: 'sonnet' }]);
    await waitFor(() => /Review 1 · claude · sonnet · queued/.test(bar(r.container)!.textContent ?? ''), 'queued');

    fake.update('R1', {
      state: 'finished',
      started: '2026-11-08T10:11:05Z',
      ended: '2026-11-08T10:11:40Z',
      verdict: 'fail',
      findings: [{ severity: 'P1', file: 'app.go', line: 40, summary: 'the retry never stops' }],
      reply: 'Looks wrong.\n{"verdict":"fail"}',
      cost_usd: 0.25,
    });
    await waitFor(() => /Checked by claude · sonnet: failed, 1 finding/.test(bar(r.container)!.textContent ?? ''), 'the verdict');

    // The CI/CD tab: the turn, then the review with its finding.
    await click(Array.from(bar(r.container)!.querySelectorAll('button')).find((b) => b.textContent === 'CI/CD'));
    const body = r.container.querySelector('#d-body')!;
    expect(body.textContent).toContain('1 review of this turn');
    expect(body.textContent).toContain('1 failed');
    expect(body.querySelector('.turn-job')!.textContent).toContain('ran 0:12');
    const review = body.querySelectorAll('.job-row')[1];
    expect(review.textContent).toContain('waited 0:05');
    expect(review.textContent).toContain('ran 0:35');
    expect(review.textContent).toContain('read-only: no commit');
    const finding = body.querySelector('.findings li')!;
    expect(finding.textContent).toContain('P1');
    expect(finding.textContent).toContain('app.go:40');
    expect(finding.textContent).toContain('the retry never stops');
    await click(Array.from(body.querySelectorAll('button')).find((b) => b.textContent === 'Show the reply'));
    expect(body.querySelector('.job-reply')?.textContent).toContain('Looks wrong.');

    // A second review of the same turn: the newest shows, the first is kept.
    await click(bar(r.container)!.querySelector('.rb-go'));
    await waitFor(() => /Review 2 · claude · sonnet/.test(bar(r.container)!.textContent ?? ''), 'the second review');
    expect(bar(r.container)!.textContent).toContain('Earlier reviews (1)');
    r.unmount();
  });

  it('waits for the turn to end, and shows a refusal in the API’s words', async () => {
    const fake = fakeQueue([row({ id: 'T1', state: 'running' })]);
    fake.src.review = async () => {
      throw new Error('the session is closed');
    };
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} queue={fake.src} />);
    await waitFor(() => r.container.querySelector('#convo .tb') !== null, 'the turn');
    await openTurn(r.container);
    await waitFor(() => bar(r.container) !== null, 'the review bar');
    await waitFor(() => (bar(r.container)!.querySelector('.rb-go') as HTMLButtonElement).disabled, 'the running row');
    expect(bar(r.container)!.textContent).toContain('Review opens when the turn ends.');

    fake.update('T1', { state: 'finished', ended: '2026-11-08T10:00:12Z' });
    await waitFor(() => !(bar(r.container)!.querySelector('.rb-go') as HTMLButtonElement).disabled, 'the end');
    await click(bar(r.container)!.querySelector('.rb-go'));
    await waitFor(() => bar(r.container)!.querySelector('.form-error') !== null, 'the error');
    expect(bar(r.container)!.querySelector('.form-error')!.textContent).toBe('the session is closed');
    r.unmount();
  });

  it('a turn the list has not read yet goes by its own state, and its CI/CD tab has no reviews', async () => {
    const fake = fakeQueue([]);
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} queue={fake.src} />);
    await waitFor(() => r.container.querySelector('#convo .tb') !== null, 'the turn');
    await openTurn(r.container);
    await waitFor(() => bar(r.container) !== null, 'the review bar');
    expect((bar(r.container)!.querySelector('.rb-go') as HTMLButtonElement).disabled).toBe(false);
    await click(ciTab(r.container));
    expect(r.container.querySelector('#d-body')!.textContent).toContain('No reviews of this turn');
    r.unmount();
  });

  it('Stop on a running review stops that turn, and shows a refusal in the API’s words', async () => {
    const fake = fakeQueue([T1, row({ id: 'R1', session: 'rs1', kind: 'review', reviews: 'T1', state: 'running', agent: 'codex' })]);
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} queue={fake.src} />);
    await waitFor(() => r.container.querySelector('#convo .tb') !== null, 'the turn');
    await openTurn(r.container);
    await waitFor(() => ciTab(r.container) !== undefined, 'the tab');
    await click(ciTab(r.container));
    await waitFor(() => r.container.querySelectorAll('#d-body .job-row').length === 2, 'the review row');
    const stopBtn = () => Array.from(r.container.querySelectorAll('#d-body .job-acts button')).find((b) => b.textContent === 'Stop');
    expect(Array.from(r.container.querySelectorAll('#d-body button')).some((b) => b.textContent === 'Cancel')).toBe(false);
    await click(stopBtn());
    expect(fake.calls.stopped).toEqual(['R1']);

    fake.src.stop = async () => {
      throw new Error('the turn has ended');
    };
    await click(stopBtn());
    await waitFor(() => r.container.querySelector('#d-body .form-error') !== null, 'the error');
    expect(r.container.querySelector('#d-body .form-error')!.textContent).toBe('the turn has ended');
    r.unmount();
  });
});

describe('Fix', () => {
  const reviewed = (verdict: 'fail' | 'pass') =>
    fakeQueue([
      T1,
      row({
        id: 'R1',
        session: 'rs1',
        kind: 'review',
        reviews: 'T1',
        agent: 'claude',
        model: 'sonnet',
        verdict,
        findings:
          verdict === 'fail'
            ? [
                { severity: 'P1', file: 'calc.go', line: 7, summary: 'adds instead of subtracting' },
                { severity: 'P3', summary: 'no test' },
              ]
            : [],
        asked: '2026-11-08T10:11:00Z',
      }),
    ]);

  it('after a failed review, fills the message box with the findings and sends nothing', async () => {
    const fake = reviewed('fail');
    const { src, sendMessage } = source(turnEvents());
    const r = await render(<App dataSource={src} queue={fake.src} />);
    await waitFor(() => r.container.querySelector('#convo .tb') !== null, 'the turn');
    await openTurn(r.container);
    await waitFor(() => bar(r.container)?.querySelector('.rb-fix') != null, 'Fix');
    await click(bar(r.container)!.querySelector('.rb-fix'));
    const box = r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement;
    expect(box.value).toBe(
      'A review of turn 1 found these problems. Fix them:\n\n- P1 calc.go:7: adds instead of subtracting\n- P3: no test'
    );
    expect(document.activeElement).toBe(box);
    expect(sendMessage).not.toHaveBeenCalled();

    // The person edits it and presses Send: the session's next turn.
    await setValue(box, box.value + '\nKeep the API the same.');
    await act(async () => {
      r.container.querySelector('#c-reply form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => sendMessage.mock.calls.length === 1, 'the send');
    const [session, req] = sendMessage.mock.calls[0] as unknown as [string, { prompt: string; read_only: boolean }];
    expect(session).toBe('s1');
    expect(req.read_only).toBe(false);
    expect(req.prompt).toContain('- P1 calc.go:7: adds instead of subtracting');
    expect(req.prompt).toContain('Keep the API the same.');
    expect(fake.calls.reviews).toHaveLength(0);
    r.unmount();
  });

  it('is not offered after a passing review', async () => {
    const fake = reviewed('pass');
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} queue={fake.src} />);
    await waitFor(() => r.container.querySelector('#convo .tb') !== null, 'the turn');
    await openTurn(r.container);
    await waitFor(() => /passed/.test(bar(r.container)?.textContent ?? ''), 'the verdict');
    expect(bar(r.container)!.querySelector('.rb-fix')).toBeNull();
    r.unmount();
  });

  it('fixPrompt says something useful with no findings', () => {
    expect(fixPrompt([], 3)).toBe('A review of turn 3 failed without naming a problem. Read that change again and fix what is wrong.');
  });
});

describe('the session CI/CD view', () => {
  it('lists the session’s turns, queued and ended, and the reviews of them with their verdict', async () => {
    const fake = fakeQueue([
      T1,
      row({ id: 'R1', session: 'rs1', kind: 'review', reviews: 'T1', state: 'finished', verdict: 'pass', findings: [], agent: 'codex', asked: '2026-11-08T10:05:00Z', started: '2026-11-08T10:05:00Z' }),
      row({ id: 'Q2', state: 'queued', ahead: 1, number: 2, asked: '2026-11-08T10:06:00Z', started: undefined }),
      row({ id: 'X', session: 'elsewhere' }),
    ]);
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} queue={fake.src} />);
    await waitFor(() => r.container.querySelector('#convo .tb') !== null, 'the turn');
    await openTurn(r.container);
    await click(r.container.querySelector('#p-head .crumb[data-level="session"]'));
    await waitFor(() => r.container.querySelectorAll('.jobs-table tbody tr').length === 3, 'three rows');
    const rows = Array.from(r.container.querySelectorAll('.jobs-table tbody tr')).map((tr) => tr.textContent);
    expect(rows[0]).toContain('turn');
    expect(rows[0]).toContain('Finished');
    expect(rows[0]).toContain('0:12');
    expect(rows[1]).toContain('review');
    expect(rows[1]).toContain('codex');
    expect(rows[1]).toContain('Passed · 0 findings');
    expect(rows[2]).toContain('Queued · 1 ahead');
    expect(Array.from(r.container.querySelectorAll('.jobs-table th')).map((th) => th.textContent)).not.toContain('Job');
    r.unmount();
  });
});

describe('sending with the turn queue', () => {
  // POST /api/v0/turns queues a message behind a running turn: one path for
  // every message.
  it('a next message goes to POST /api/v0/turns', async () => {
    const fake = fakeQueue([T1]);
    const { src, sendMessage } = source(turnEvents());
    const r = await render(<App dataSource={src} queue={fake.src} />);
    await waitFor(() => r.container.querySelector('#convo .tb') !== null, 'the turn');
    await setValue(r.container.querySelector('#c-reply textarea'), 'now add a test');
    await act(async () => {
      r.container.querySelector('#c-reply form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => sendMessage.mock.calls.length === 1, 'the send');
    expect(sendMessage.mock.calls[0]).toEqual(['s1', { prompt: 'now add a test', read_only: false, agent: expect.any(String), idempotency_key: expect.stringMatching(/^cockpit-msg-/) }]);
    r.unmount();
  });

  // New session is a saved agent and a folder: POST /api/v0/turns names the
  // agent's id and isolate, and the service makes the copy. No worktree,
  // base, model or read-only choice is shown, and the note says the
  // conversation works on its own copy of the folder.
  it('New session starts a turn with the agent, the folder and isolate, and shows no workspace choice', async () => {
    const fake = fakeQueue([]);
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} queue={fake.src} />);
    await waitFor(() => r.container.querySelector('#sessions button.new-session') !== null, 'New session');
    await click(r.container.querySelector('#sessions button.new-session'));
    await flush();
    const dialog = r.container.querySelector('.new-dialog')!;
    expect(dialog.textContent).not.toContain('New worktree');
    expect(dialog.textContent).not.toContain('worktree');
    expect(dialog.textContent).toContain('works on its own copy');
    expect(dialog.querySelector('[role="radiogroup"]')).toBeNull();
    expect(dialog.querySelector('input[name="base"], input[name="model"], input[name="read_only"]')).toBeNull();
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/repo');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'add hello.txt');
    await act(async () => {
      dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => (src.startRun as ReturnType<typeof vi.fn>).mock.calls.length === 1, 'the start');
    expect((src.startRun as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      agent: 'claude',
      folder: '/Users/ana/repo',
      isolate: true,
      prompt: 'add hello.txt',
    });
    r.unmount();
  });
});

describe('queue data', () => {
  it('ties reviews to the turn they review, and lists them with that turn’s session', () => {
    const v = queueView(
      [
        row({ id: 'T2', asked: '2026-11-08T10:03:00Z' }),
        row({ id: 'r2', session: 'rs2', kind: 'review', reviews: 'T1', asked: '2026-11-08T10:02:00Z' }),
        row({ id: 'r1', session: 'rs1', kind: 'review', reviews: 'T1', asked: '2026-11-08T10:01:00Z' }),
        row({ id: 'T1' }),
        row({ id: 'Y', session: 's2' }),
      ],
      null,
      () => {}
    );
    expect(v.turnOf('s1', 'T1')?.id).toBe('T1');
    expect(v.turnOf('s2', 'T1')).toBeUndefined();
    expect(v.turnOf('rs1', 'r1')).toBeUndefined();
    expect(v.reviewsOf('T1').map((t) => t.id)).toEqual(['r1', 'r2']);
    expect(v.ofSession('s1').map((t) => t.id)).toEqual(['T1', 'r1', 'r2', 'T2']);
    expect(v.ofSession('rs1')).toEqual([]);
  });

  it('times how long a turn waited and ran', () => {
    const now = new Date('2026-11-08T10:02:00Z').getTime();
    expect(turnTimes(row({ id: 'q', state: 'queued', started: undefined }), now)).toEqual({ waitedMs: 120_000 });
    expect(turnTimes(row({ id: 'r', state: 'running', started: '2026-11-08T10:00:30Z' }), now)).toEqual({ waitedMs: 30_000, ranMs: 90_000 });
    expect(turnTimes(row({ id: 'f', ended: '2026-11-08T10:00:10Z' }), now)).toEqual({ waitedMs: 0, ranMs: 10_000 });
  });

  it('the first reviewer offered is another vendor when there is one', () => {
    expect(defaultReviewer('claude', ['claude', 'codex'])).toBe('codex');
    expect(defaultReviewer('codex', ['claude', 'codex'])).toBe('claude');
    expect(defaultReviewer('claude', ['claude'])).toBe('claude');
    expect(defaultReviewer('claude', ['claude', 'opencode'])).toBe('opencode');
  });

  it('probeQueue says no queue only on a 404 from GET /api/v0/turns', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"not found"}', { status: 404 })));
    expect(await probeQueue('http://agentbus.test', 't')).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"x"}', { status: 500 })));
    expect(await probeQueue('http://agentbus.test', 't')).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
    expect(await probeQueue('http://agentbus.test', 't')).toBe(true);
    const fn = vi.fn(async () => new Response('{"turns":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fn);
    expect(await probeQueue('http://agentbus.test', 't')).toBe(true);
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://agentbus.test/api/v0/turns?limit=1');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer t');
  });

  it('TurnsClient lists turns, asks a review by turn id, and stops a turn', async () => {
    const seen: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined });
        if (url.endsWith('/stop') && seen.length > 3) return new Response('{"error":"the turn has ended"}', { status: 409 });
        if (url.includes('/review')) return new Response('{"session":"rs","turn":"R","state":"queued"}', { status: 202 });
        if (url.endsWith('/stop')) return new Response('{"session":"s1","turn":"T/1"}', { status: 202 });
        return new Response('{"store":"st","seq":1,"turns":[{"id":"T1"}],"next_before":null}', { status: 200 });
      })
    );
    const c = new TurnsClient('http://agentbus.test', 't');
    expect((await c.listTurns()).map((t) => t.id)).toEqual(['T1']);
    expect(seen[0].url).toBe('http://agentbus.test/api/v0/turns?limit=200');
    expect(await c.review('T/1', { agent: 'codex', model: 'gpt-5.5' })).toEqual({ session: 'rs', turn: 'R', state: 'queued' });
    expect(seen[1].url).toBe('http://agentbus.test/api/v0/turns/T%2F1/review');
    expect(seen[1].method).toBe('POST');
    expect(seen[1].body).toMatchObject({ agent: 'codex', model: 'gpt-5.5', idempotency_key: expect.stringMatching(/^cockpit-review-/) });
    await c.stop('T/1');
    expect(seen[2]).toMatchObject({ url: 'http://agentbus.test/api/v0/turns/T%2F1/stop', method: 'POST' });
    await expect(c.stop('T1')).rejects.toThrow('the turn has ended');
  });
});
