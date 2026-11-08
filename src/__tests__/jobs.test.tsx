// @vitest-environment jsdom
// The job queue: turns that run as jobs, the Review button, and the CI/CD
// views. A fake JobsSource stands in for the jobs API.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import {
  defaultReviewer,
  fixPrompt,
  Job,
  JobEvent,
  JobSpec,
  JobsSource,
  probeJobs,
  resultRef,
  ReviewRequest,
  startTurnJob,
} from '../data/jobs';
import { jobsView } from '../data/useJobs';
import { CockpitEvent, DataSource } from '../types';
import { click, ev, flush, liveReplay, render } from './helpers';

const T0 = '2026-11-08T10:00:00Z';

function job(fields: Partial<Job> & { id: string }): Job {
  return {
    kind: 'turn',
    state: 'finished',
    spec: { agent: 'claude', repo: '/w', base: 'HEAD', prompt: 'add a file' },
    verdict: null,
    created: T0,
    updated: T0,
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

// A control plane in memory. Tests change `state.jobs` and the next read
// (every 10 ms) shows it.
function fakeJobs(initial: Job[]) {
  const state = { jobs: [...initial], events: {} as Record<string, JobEvent[]> };
  const calls = { reviews: [] as [string, ReviewRequest][], created: [] as JobSpec[], cancelled: [] as string[] };
  let n = 0;
  const src: JobsSource = {
    address: 'http://jobs.test',
    pollMs: 10,
    listJobs: async () => state.jobs.slice().reverse(),
    getJob: async (id) => state.jobs.find((j) => j.id === id)!,
    createTurnJob: async (spec) => {
      calls.created.push(spec);
      const id = `job_new${++n}`;
      const at = `att_new${n}`;
      const j = job({
        id,
        state: 'running',
        spec,
        attempt: at,
        attempts: [{ id: at, number: 1, runner: 'run_mac', state: 'running', taken: T0, started: T0 }],
        created: `2026-11-08T10:0${n}:00Z`,
      });
      state.jobs.push(j);
      state.events[at] = [{ seq: 1, time: T0, kind: 'turn.created', data: { session: spec.session ?? 'new1', turn: `Tnew${n}` } }];
      return j;
    },
    review: async (id, req) => {
      calls.reviews.push([id, req]);
      const r = job({
        id: `job_rev${calls.reviews.length}`,
        kind: 'review',
        state: 'queued',
        spec: { agent: req.agent, model: req.model, prompt: 'review', read_only: true },
        links: { reviews_job: id },
        session: 's1',
        created: `2026-11-08T10:1${calls.reviews.length}:00Z`,
      });
      state.jobs.push(r);
      return r;
    },
    cancel: async (id) => {
      calls.cancelled.push(id);
    },
    attemptEvents: async (id) => state.events[id] ?? [],
  };
  const update = (id: string, fields: Partial<Job>) => {
    state.jobs = state.jobs.map((j) => (j.id === id ? { ...j, ...fields } : j));
  };
  return { src, state, calls, update };
}

// The replay source, with sessions that take a next message and agents to
// pick from.
function source(events: CockpitEvent[], extra: Partial<DataSource> = {}) {
  const base = liveReplay(events);
  const resumable = <T extends { resumable?: boolean }>(list: T[]) => list.map((s) => ({ ...s, resumable: true }));
  const sendMessage = vi.fn(async (id: string) => ({ id, turn: 'Tdirect' }));
  const src: DataSource = {
    ...base.source,
    getSessions: async (a) => resumable(await base.source.getSessions(a)),
    subscribe: (cb, snap) => base.source.subscribe!(cb, (list, c) => snap?.(resumable(list), c)),
    getInstalledAgents: async () => [
      { name: 'claude', found: true },
      { name: 'codex', found: true },
    ],
    startRun: vi.fn(async () => ({ id: 'direct', turn: 'Tdirect' })),
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

async function openTurn(c: HTMLElement) {
  await flush();
  await click(c.querySelector('#convo .tb'));
  await flush();
}

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

describe('without a job queue', () => {
  it('shows no Review and no CI/CD tab', async () => {
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} />);
    await openTurn(r.container);
    expect(bar(r.container)).toBeNull();
    expect(tabNames(r.container)).not.toContain('CI/CD');
    r.unmount();
  });
});

describe('by default, with a job queue', () => {
  it('hides Review, Fix, the CI/CD tab and the session job list', async () => {
    vi.stubEnv('VITE_REVIEW_UI', '');
    const fake = fakeJobs([
      job({ id: 'job_1', result: { session: 's1', turn: 'T1', changes: { count: 1 } }, attempts: [{ id: 'att_1', number: 1, runner: 'run_mac', state: 'finished', taken: T0, started: T0, ended: '2026-11-08T10:00:12Z' }] }),
    ]);
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} jobs={fake.src} />);
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
  it('offers another vendor first, makes a review job, and shows its verdict and findings', async () => {
    const fake = fakeJobs([
      job({ id: 'job_1', result: { session: 's1', turn: 'T1', changes: { count: 1 } }, attempts: [{ id: 'att_1', number: 1, runner: 'run_mac', state: 'finished', taken: T0, started: T0, ended: '2026-11-08T10:00:12Z' }] }),
    ]);
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} jobs={fake.src} />);
    await waitFor(() => r.container.querySelector('#convo .tb') !== null, 'the turn');
    await openTurn(r.container);
    await waitFor(() => bar(r.container) !== null, 'the review bar');
    const select = bar(r.container)!.querySelector('select[name="reviewer"]') as HTMLSelectElement;
    expect(select.value).toBe('codex');
    expect(tabNames(r.container)).toContain('CI/CD');

    // Claude can review Claude's turn, and the bar says it is the same vendor.
    await setValue(select, 'claude');
    expect((bar(r.container)!.querySelector('input[name="reviewer-model"]') as HTMLInputElement).value).toBe('sonnet');
    expect(bar(r.container)!.textContent).toContain('Same vendor as the author.');

    await click(bar(r.container)!.querySelector('.rb-go'));
    await waitFor(() => fake.calls.reviews.length === 1, 'the review call');
    expect(fake.calls.reviews[0]).toEqual(['job_1', { agent: 'claude', model: 'sonnet' }]);
    await waitFor(() => /Review 1 · claude · sonnet · queued/.test(bar(r.container)!.textContent ?? ''), 'queued');

    fake.update('job_rev1', {
      state: 'finished',
      verdict: 'fail',
      findings: [{ severity: 'P1', file: 'app.go', line: 40, summary: 'the retry never stops' }],
      result: { reply_text: 'Looks wrong.\n{"verdict":"fail"}' },
    });
    await waitFor(() => /Checked by claude · sonnet: failed, 1 finding/.test(bar(r.container)!.textContent ?? ''), 'the verdict');

    // The CI/CD tab: the turn as a job, then the review with its finding.
    await click(Array.from(bar(r.container)!.querySelectorAll('button')).find((b) => b.textContent === 'CI/CD'));
    const body = r.container.querySelector('#d-body')!;
    expect(body.textContent).toContain('2 jobs on this turn');
    expect(body.textContent).toContain('1 failed');
    expect(body.textContent).toContain('1 file changed');
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

  it('waits for the turn job to end, and shows a refusal in the API’s words', async () => {
    const fake = fakeJobs([job({ id: 'job_1', state: 'running', result: { session: 's1', turn: 'T1' } })]);
    fake.src.review = async () => {
      throw new Error('the session is closed');
    };
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} jobs={fake.src} />);
    await waitFor(() => r.container.querySelector('#convo .tb') !== null, 'the turn');
    await openTurn(r.container);
    await waitFor(() => bar(r.container) !== null, 'the review bar');
    const go = bar(r.container)!.querySelector('.rb-go') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(bar(r.container)!.textContent).toContain('Review opens when the turn ends.');

    fake.update('job_1', { state: 'finished' });
    await waitFor(() => !(bar(r.container)!.querySelector('.rb-go') as HTMLButtonElement).disabled, 'the end');
    await click(bar(r.container)!.querySelector('.rb-go'));
    await waitFor(() => bar(r.container)!.querySelector('.form-error') !== null, 'the error');
    expect(bar(r.container)!.querySelector('.form-error')!.textContent).toBe('the session is closed');
    r.unmount();
  });

  it('a turn no job ran has no Review, and its CI/CD tab says why', async () => {
    const fake = fakeJobs([]);
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} jobs={fake.src} />);
    await waitFor(() => r.container.querySelector('#convo .tb') !== null, 'the turn');
    await openTurn(r.container);
    expect(bar(r.container)).toBeNull();
    await click(Array.from(r.container.querySelectorAll('#d-tabs .tab')).find((t) => t.textContent === 'CI/CD'));
    expect(r.container.querySelector('#d-body')!.textContent).toContain('This turn has no job');
    r.unmount();
  });
});

describe('Fix', () => {
  const failed = (verdict: 'fail' | 'pass') =>
    fakeJobs([
      job({ id: 'job_1', result: { session: 's1', turn: 'T1', changes: { count: 1 } } }),
      job({
        id: 'job_rev1',
        kind: 'review',
        spec: { agent: 'claude', model: 'sonnet', prompt: 'review', read_only: true },
        links: { reviews_job: 'job_1' },
        session: 's1',
        verdict,
        findings:
          verdict === 'fail'
            ? [
                { severity: 'P1', file: 'calc.go', line: 7, summary: 'adds instead of subtracting' },
                { severity: 'P3', summary: 'no test' },
              ]
            : [],
        created: '2026-11-08T10:11:00Z',
      }),
    ]);

  it('after a failed review, fills the message box with the findings and sends nothing', async () => {
    const fake = failed('fail');
    const { src, sendMessage } = source(turnEvents());
    const r = await render(<App dataSource={src} jobs={fake.src} />);
    await waitFor(() => r.container.querySelector('#convo .tb') !== null, 'the turn');
    await openTurn(r.container);
    await waitFor(() => bar(r.container)?.querySelector('.rb-fix') != null, 'Fix');
    await click(bar(r.container)!.querySelector('.rb-fix'));
    const box = r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement;
    expect(box.value).toBe(
      'A review of turn 1 found these problems. Fix them:\n\n- P1 calc.go:7: adds instead of subtracting\n- P3: no test'
    );
    expect(document.activeElement).toBe(box);
    expect(fake.calls.created).toHaveLength(0);

    // The person edits it and presses Send: the next turn job of the session.
    await setValue(box, box.value + '\nKeep the API the same.');
    await act(async () => {
      r.container.querySelector('#c-reply form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => fake.calls.created.length === 1, 'the job');
    expect(fake.calls.created[0].session).toBe('s1');
    expect(fake.calls.created[0].read_only).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(fake.calls.created[0].prompt).toContain('- P1 calc.go:7: adds instead of subtracting');
    expect(fake.calls.created[0].prompt).toContain('Keep the API the same.');
    r.unmount();
  });

  it('is not offered after a passing review', async () => {
    const fake = failed('pass');
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} jobs={fake.src} />);
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
  it('lists the session’s jobs with state, runner and verdict', async () => {
    const fake = fakeJobs([
      job({ id: 'job_1', result: { session: 's1', turn: 'T1' }, attempts: [{ id: 'att_1', number: 1, runner: 'run_mac', state: 'finished', taken: T0, started: T0, ended: '2026-11-08T10:00:12Z' }] }),
      job({
        id: 'job_rev1',
        kind: 'review',
        state: 'finished',
        verdict: 'pass',
        findings: [],
        spec: { agent: 'codex', prompt: 'review', read_only: true },
        links: { reviews_job: 'job_1' },
        session: 's1',
        created: '2026-11-08T10:05:00Z',
      }),
      job({ id: 'job_other', session: 'elsewhere', result: { session: 'elsewhere', turn: 'X' } }),
    ]);
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} jobs={fake.src} />);
    await waitFor(() => r.container.querySelector('#convo .tb') !== null, 'the turn');
    await openTurn(r.container);
    await click(r.container.querySelector('#p-head .crumb[data-level="session"]'));
    await waitFor(() => r.container.querySelectorAll('.jobs-table tbody tr').length === 2, 'two job rows');
    const rows = Array.from(r.container.querySelectorAll('.jobs-table tbody tr')).map((tr) => tr.textContent);
    expect(rows[0]).toContain('turn');
    expect(rows[0]).toContain('Finished');
    expect(rows[0]).toContain('run_mac');
    expect(rows[0]).toContain('0:12');
    expect(rows[1]).toContain('review');
    expect(rows[1]).toContain('Passed · 0 findings');
    r.unmount();
  });
});

describe('sending with the job queue', () => {
  it('a next message is a turn job of the session, not a direct turn', async () => {
    const fake = fakeJobs([job({ id: 'job_1', result: { session: 's1', turn: 'T1' } })]);
    const { src, sendMessage } = source(turnEvents());
    const r = await render(<App dataSource={src} jobs={fake.src} />);
    await waitFor(() => r.container.querySelector('#convo .tb') !== null, 'the turn');
    await setValue(r.container.querySelector('#c-reply textarea'), 'now add a test');
    await act(async () => {
      r.container.querySelector('#c-reply form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => fake.calls.created.length === 1, 'the job');
    expect(fake.calls.created[0]).toEqual({ session: 's1', prompt: 'now add a test' });
    expect(sendMessage).not.toHaveBeenCalled();
    r.unmount();
  });

  it('New session offers a worktree, and makes a job with repo, base and model', async () => {
    const fake = fakeJobs([]);
    const { src } = source(turnEvents());
    const r = await render(<App dataSource={src} jobs={fake.src} />);
    await waitFor(() => r.container.querySelector('#sessions button.new-session') !== null, 'New session');
    await click(r.container.querySelector('#sessions button.new-session'));
    await flush();
    const dialog = r.container.querySelector('.new-dialog')!;
    expect(dialog.textContent).toContain('New worktree');
    await setValue(dialog.querySelector('input[name="folder"]'), '/Users/ana/repo');
    await setValue(dialog.querySelector('input[name="base"]'), 'main');
    await setValue(dialog.querySelector('input[name="model"]'), 'haiku');
    await setValue(dialog.querySelector('textarea[name="prompt"]'), 'add hello.txt');
    await act(async () => {
      dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => fake.calls.created.length === 1, 'the job');
    expect(fake.calls.created[0]).toEqual({
      agent: 'claude',
      repo: '/Users/ana/repo',
      base: 'main',
      prompt: 'add hello.txt',
      model: 'haiku',
      read_only: false,
    });
    expect(src.startRun).not.toHaveBeenCalled();
    r.unmount();
  });
});

describe('jobs data', () => {
  it('ties turn jobs to turns from results and from attempt events, and reviews to their job', () => {
    const v = jobsView(
      [
        job({ id: 'a', result: { session: 's1', turn: 'T1' } }),
        job({ id: 'b', state: 'running' }),
        job({ id: 'r2', kind: 'review', links: { reviews_job: 'a' }, session: 's1', created: '2026-11-08T10:02:00Z' }),
        job({ id: 'r1', kind: 'review', links: { reviews_job: 'a' }, session: 's1', created: '2026-11-08T10:01:00Z' }),
      ],
      { b: { session: 's1', turn: 'T2' } },
      null,
      () => {}
    );
    expect(v.turnJob('s1', 'T1')?.id).toBe('a');
    expect(v.turnJob('s1', 'T2')?.id).toBe('b');
    expect(v.turnJob('s2', 'T1')).toBeUndefined();
    expect(v.reviewsOf('a').map((j) => j.id)).toEqual(['r1', 'r2']);
    expect(v.ofSession('s1').map((j) => j.id)).toEqual(['a', 'b', 'r1', 'r2']);
  });

  it('startTurnJob waits for turn.created, and says why a job ended without a turn', async () => {
    const fake = fakeJobs([]);
    const { ref } = await startTurnJob(fake.src, { agent: 'claude', folder: '/w', prompt: 'x' }, { intervalMs: 1 });
    expect(ref).toEqual({ session: 'new1', turn: 'Tnew1' });

    fake.src.createTurnJob = async () => job({ id: 'j_bad', state: 'failed', reason: 'turn_refused' });
    await expect(startTurnJob(fake.src, { agent: 'claude', folder: '/w', prompt: 'x' }, { intervalMs: 1 })).rejects.toThrow(
      'the job failed: turn_refused'
    );

    fake.src.createTurnJob = async () => job({ id: 'j_q', state: 'queued' });
    fake.src.getJob = async () => job({ id: 'j_q', state: 'queued' });
    await expect(
      startTurnJob(fake.src, { agent: 'claude', folder: '/w', prompt: 'x' }, { intervalMs: 1, timeoutMs: 5 })
    ).rejects.toThrow('no runner took job j_q yet; it stays in the queue');
  });

  it('the first reviewer offered is another vendor when there is one', () => {
    expect(defaultReviewer('claude', ['claude', 'codex'])).toBe('codex');
    expect(defaultReviewer('codex', ['claude', 'codex'])).toBe('claude');
    expect(defaultReviewer('claude', ['claude'])).toBe('claude');
    expect(defaultReviewer('claude', ['claude', 'opencode'])).toBe('opencode');
  });

  it('a job’s attempt is its turn: the newest attempt whose turn started, in the session the job names', () => {
    const at = (id: string, started: boolean) => ({ id, number: 1, runner: 'run_mac', state: 'running', taken: T0, started: T0, turn_started: started || undefined });
    expect(resultRef(job({ id: 'j', state: 'running', session: 's9', attempts: [at('t_1', true)] }))).toEqual({ session: 's9', turn: 't_1' });
    // Started, but its turn did not start (yet, or ever): no turn.
    expect(resultRef(job({ id: 'j', state: 'running', session: 's9', attempts: [at('t_1', false)] }))).toBeNull();
    expect(resultRef(job({ id: 'j', state: 'failed', reason: 'runner_lost', session: 's9', attempts: [at('t_1', true), at('t_2', false)] }))).toEqual({ session: 's9', turn: 't_1' });
    expect(resultRef(job({ id: 'r', kind: 'review', session: 's9', attempts: [at('t_2', true)] }))).toBeNull();
  });

  it('probeJobs says no queue only on a 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"this service keeps no job queue"}', { status: 404 })));
    expect(await probeJobs('http://agentbus.test', 't')).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"x"}', { status: 500 })));
    expect(await probeJobs('http://agentbus.test', 't')).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
    expect(await probeJobs('http://agentbus.test', 't')).toBe(true);
    const fn = vi.fn(async () => new Response('{"jobs":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fn);
    expect(await probeJobs('http://agentbus.test', 't')).toBe(true);
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://agentbus.test/api/v0/jobs?limit=1');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer t');
  });
});
