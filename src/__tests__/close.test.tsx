// @vitest-environment jsdom
// Closing a conversation (PATCH closed: true, after the person confirms in
// the cockpit's own dialog) and Export (every event, saved as one .jsonl).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { CLOSE_NOTE, CLOSE_RUNNING } from '../components/ConvoColumn';
import { LiveDataSource } from '../data/LiveDataSource';
import { recordFileName, recordText } from '../data/exportRecord';
import { ApplyPreview } from '../types';
import { click, ev, flush, liveReplay, render } from './helpers';

const finished = [
  ev({ seq: 1, session: 'c1', kind: 'session.registered', agent: 'claude', folder: '/w' }),
  ev({ seq: 2, session: 'c1', kind: 'turn.started', turn: 'T1', exchange: 'x1', text: 'edit a.txt' }),
  ev({ seq: 3, session: 'c1', kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
  ev({ seq: 4, session: 'c1', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: 'done' }),
  ev({ seq: 5, session: 'c1', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
];

const unapplied: ApplyPreview = {
  session: 'c1',
  isolated: true,
  unapplied: true,
  turn: 'T1',
  count: 2,
  files: [
    { path: 'a.txt', change: 'modified' },
    { path: 'b.txt', change: 'added' },
  ],
  conflicts: [],
};

const button = (c: ParentNode, text: string) =>
  Array.from(c.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement | undefined;
const ask = () => document.querySelector('.close-ask') as HTMLElement | null;

async function open(extra: Parameters<typeof liveReplay>[1]) {
  const lr = liveReplay(finished, extra);
  const r = await render(<App dataSource={lr.source} />);
  await flush();
  await flush();
  return { ...lr, r };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Close', () => {
  it('asks first in the cockpit\'s own dialog, never the browser\'s; Keep it open sends nothing', async () => {
    const closeSession = vi.fn(async () => 'closed' as const);
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const { r } = await open({ closeSession });
    const close = r.container.querySelector('#c-head .c-close') as HTMLButtonElement;
    expect(close.textContent).toBe('Close');
    await click(close);
    expect(confirm).not.toHaveBeenCalled();
    const d = ask()!;
    expect(d.getAttribute('role')).toBe('alertdialog');
    expect(d.querySelector('.nd-title')!.textContent).toBe('Close this conversation?');
    expect(d.querySelector('.nd-note')!.textContent).toBe(CLOSE_NOTE);
    expect(d.querySelector('.close-unapplied')).toBeNull();
    await click(button(d, 'Keep it open'));
    expect(ask()).toBeNull();
    expect(closeSession).not.toHaveBeenCalled();
    r.unmount();
  });

  it('closes on Close conversation: the header says closed, Close goes, and Send is off', async () => {
    const closeSession = vi.fn(async () => 'closed' as const);
    const { r } = await open({ closeSession });
    await click(r.container.querySelector('#c-head .c-close'));
    await click(button(ask()!, 'Close conversation'));
    await flush();
    expect(closeSession).toHaveBeenCalledWith('c1');
    expect(ask()).toBeNull();
    expect(r.container.querySelector('#c-head .c-closed')!.textContent).toBe('closed');
    expect(r.container.querySelector('#c-head .c-close')).toBeNull();
    expect((r.container.querySelector('#input') as HTMLTextAreaElement).disabled).toBe(true);
    r.unmount();
  });

  it('warns of changes not applied: "Apply what you want to keep first"', async () => {
    const { r } = await open({ closeSession: vi.fn(), getApplyPreview: vi.fn(async () => unapplied), applyTurn: vi.fn() });
    await click(r.container.querySelector('#c-head .c-close'));
    expect(ask()!.querySelector('.close-unapplied')!.textContent).toBe(
      '2 files changed here are not in your folder yet. Apply what you want to keep first.'
    );
    r.unmount();
  });

  it('a turn still running (409) is said plainly, and the dialog stays; other refusals in the API words', async () => {
    const closeSession = vi
      .fn()
      .mockResolvedValueOnce('running')
      .mockRejectedValueOnce(new Error('only the main token closes a session'));
    const { r } = await open({ closeSession });
    await click(r.container.querySelector('#c-head .c-close'));
    await click(button(ask()!, 'Close conversation'));
    await flush();
    expect(ask()!.querySelector('.close-refused')!.textContent).toBe(CLOSE_RUNNING);
    expect(CLOSE_RUNNING).toBe('A turn is still running. Stop it or wait for it to end, then close.');
    await click(button(ask()!, 'Close conversation'));
    await flush();
    expect(ask()!.querySelector('.close-refused')!.textContent).toBe('only the main token closes a session');
    expect(r.container.querySelector('#c-head .c-closed')).toBeNull();
    r.unmount();
  });

  it('is not offered by a source that cannot close', async () => {
    const { r } = await open({});
    expect(r.container.querySelector('#c-head .c-close')).toBeNull();
    expect(r.container.querySelector('#c-head .c-export')).toBeNull();
    r.unmount();
  });
});

describe('Export', () => {
  it('is a quiet link beside Close that saves every event as one .jsonl file', async () => {
    const events = [
      { seq: 1, kind: 'session.registered' },
      { seq: 2, kind: 'turn.started', text: 'a\nb' },
    ];
    const getSessionEvents = vi.fn(async () => events);
    const blobs: Blob[] = [];
    const u = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
    const kept = { create: u.createObjectURL, revoke: u.revokeObjectURL };
    u.createObjectURL = (b: Blob) => (blobs.push(b), 'blob:x');
    u.revokeObjectURL = () => undefined;
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    const { r } = await open({ getSessionEvents, closeSession: vi.fn() });
    const link = r.container.querySelector('#c-head .c-acts .c-export') as HTMLButtonElement;
    expect(link.textContent).toBe('Export');
    expect(link.className).toContain('link-btn');
    expect(link.nextElementSibling!.className).toContain('c-close');
    await click(link);
    await flush();
    expect(getSessionEvents).toHaveBeenCalledWith('c1');
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/c1\.jsonl$/);
    const text = await new Promise<string>((ok) => {
      const fr = new FileReader();
      fr.onload = () => ok(fr.result as string);
      fr.readAsText(blobs[0]);
    });
    expect(text).toBe('{"seq":1,"kind":"session.registered"}\n{"seq":2,"kind":"turn.started","text":"a\\nb"}\n');
    r.unmount();
    u.createObjectURL = kept.create;
    u.revokeObjectURL = kept.revoke;
  });

  it('a failed read shows the API words beside it', async () => {
    const { r } = await open({ getSessionEvents: vi.fn(async () => Promise.reject(new Error('the store could not be read'))) });
    await click(r.container.querySelector('#c-head .c-export'));
    await flush();
    expect(r.container.querySelector('#c-head .c-act-error')!.textContent).toBe('Export failed: the store could not be read');
    r.unmount();
  });

  it('names the file from the conversation name and id', () => {
    expect(recordFileName('Fix the login bug!', '5e7d3ab9cfae753b')).toBe('fix-the-login-bug-5e7d3ab9cfae753b.jsonl');
    expect(recordFileName('5e7d3ab9cfae753b', '5e7d3ab9cfae753b')).toBe('5e7d3ab9cfae753b.jsonl');
    expect(recordFileName('Привет', 'c1')).toBe('c1.jsonl');
    expect(recordFileName('x'.repeat(100), 'c1')).toBe(`${'x'.repeat(60)}-c1.jsonl`);
    expect(recordText([])).toBe('');
  });
});

describe('The live source', () => {
  it('closes with PATCH closed: true, and takes a 409 as a turn still running', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`);
        if (url.endsWith('/busy')) return new Response('{"error":"A turn of the session has not ended"}', { status: 409 });
        if (url.endsWith('/no')) return new Response('{"error":"only the main token closes a session"}', { status: 403 });
        return new Response('{"session":"c1"}', { status: 200 });
      })
    );
    const src = new LiveDataSource({ baseUrl: 'http://cockpit.test', token: 'tok' });
    expect(await src.closeSession('c1')).toBe('closed');
    expect(await src.closeSession('busy')).toBe('running');
    await expect(src.closeSession('no')).rejects.toThrow('only the main token closes a session');
    expect(calls[0]).toBe('PATCH http://cockpit.test/api/v0/sessions/c1 {"closed":true}');
  });

  it('pages the events 1000 at a time by store and next_after, and starts over once on 409', async () => {
    const urls: string[] = [];
    let store = 's1';
    let first = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        const q = new URL(url).searchParams;
        if (q.get('store') === 's1' && first) {
          first = false;
          store = 's2';
          return new Response('{"error":"store changed"}', { status: 409 });
        }
        if (!q.get('after')) return new Response(JSON.stringify({ store, events: [{ seq: 1 }], next_after: 1 }), { status: 200 });
        return new Response(JSON.stringify({ store, events: [{ seq: 2 }], next_after: null }), { status: 200 });
      })
    );
    const src = new LiveDataSource({ baseUrl: 'http://cockpit.test', token: 'tok' });
    expect(await src.getSessionEvents('c1')).toEqual([{ seq: 1 }, { seq: 2 }]);
    expect(urls).toEqual([
      'http://cockpit.test/api/v0/sessions/c1/events?limit=1000',
      'http://cockpit.test/api/v0/sessions/c1/events?limit=1000&store=s1&after=1',
      'http://cockpit.test/api/v0/sessions/c1/events?limit=1000',
      'http://cockpit.test/api/v0/sessions/c1/events?limit=1000&store=s2&after=1',
    ]);
  });
});
