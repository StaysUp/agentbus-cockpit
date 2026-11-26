// @vitest-environment jsdom
// Archiving a conversation (PATCH archived: true|false, a direct toggle, no
// confirm: archive is only a view and removes nothing) and Export (every
// event, saved as one .jsonl).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ARCHIVE_RUNNING } from '../components/ConvoColumn';
import { LiveDataSource } from '../data/LiveDataSource';
import { recordFileName, recordText } from '../data/exportRecord';
import { click, ev, flush, liveReplay, render } from './helpers';

const finished = [
  ev({ seq: 1, session: 'c1', kind: 'session.registered', agent: 'claude', folder: '/w' }),
  ev({ seq: 2, session: 'c1', kind: 'turn.started', turn: 'T1', exchange: 'x1', text: 'edit a.txt' }),
  ev({ seq: 3, session: 'c1', kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
  ev({ seq: 4, session: 'c1', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: 'done' }),
  ev({ seq: 5, session: 'c1', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
];

const archiveBtn = (r: { container: ParentNode }) => r.container.querySelector('#c-head .c-archive') as HTMLButtonElement | null;

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

describe('Archive', () => {
  it('archives on one click, no confirm; the button becomes Unarchive and the box still takes input', async () => {
    const archiveSession = vi.fn(async () => 'ok' as const);
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const { r } = await open({ archiveSession });
    const btn = archiveBtn(r)!;
    expect(btn.textContent).toBe('Archive');
    // Archive is only a view, so it adds no lock: the input's state is whatever
    // it was before (here, governed by resumable), unchanged by archiving.
    const inputDisabledBefore = (r.container.querySelector('#input') as HTMLTextAreaElement).disabled;
    await click(btn);
    await flush();
    // No dialog of either kind: archive is a direct, reversible toggle.
    expect(confirm).not.toHaveBeenCalled();
    expect(document.querySelector('.close-ask')).toBeNull();
    expect(archiveSession).toHaveBeenCalledWith('c1', true);
    // The convo stays usable (archive is only a view): the button now unarchives.
    expect(archiveBtn(r)!.textContent).toBe('Unarchive');
    expect((r.container.querySelector('#input') as HTMLTextAreaElement).disabled).toBe(inputDisabledBefore);
    // Unarchive sends archived:false.
    await click(archiveBtn(r)!);
    await flush();
    expect(archiveSession).toHaveBeenCalledWith('c1', false);
    expect(archiveBtn(r)!.textContent).toBe('Archive');
    r.unmount();
  });

  it('a session with no turn finished yet (409) says so inline, and stays as it was', async () => {
    const archiveSession = vi.fn(async () => 'running' as const);
    const { r } = await open({ archiveSession });
    await click(archiveBtn(r)!);
    await flush();
    expect(r.container.querySelector('#c-head .c-act-error')!.textContent).toBe(ARCHIVE_RUNNING);
    // Not archived: still offers Archive.
    expect(archiveBtn(r)!.textContent).toBe('Archive');
    r.unmount();
  });

  it('a refusal shows the API words inline', async () => {
    const archiveSession = vi.fn(async () => Promise.reject(new Error('only the main token archives a session')));
    const { r } = await open({ archiveSession });
    await click(archiveBtn(r)!);
    await flush();
    expect(r.container.querySelector('#c-head .c-act-error')!.textContent).toBe('only the main token archives a session');
    r.unmount();
  });

  it('is not offered by a source that cannot archive', async () => {
    const { r } = await open({});
    expect(archiveBtn(r)).toBeNull();
    expect(r.container.querySelector('#c-head .c-export')).toBeNull();
    r.unmount();
  });
});

describe('Export', () => {
  it('is a quiet link beside Archive that saves every event as one .jsonl file', async () => {
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
    const { r } = await open({ getSessionEvents, archiveSession: vi.fn() });
    const link = r.container.querySelector('#c-head .c-acts .c-export') as HTMLButtonElement;
    expect(link.textContent).toBe('Export');
    expect(link.className).toContain('link-btn');
    expect(link.nextElementSibling!.className).toContain('c-archive');
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
  it('archives with PATCH archived: true, un-archives with false, and takes a 409 as not-yet-finished', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`);
        if (url.endsWith('/busy')) return new Response('{"error":"this session has not finished a turn"}', { status: 409 });
        if (url.endsWith('/no')) return new Response('{"error":"only the main token archives a session"}', { status: 403 });
        return new Response('{"id":"c1"}', { status: 200 });
      })
    );
    const src = new LiveDataSource({ baseUrl: 'http://cockpit.test', token: 'tok' });
    expect(await src.archiveSession('c1', true)).toBe('ok');
    expect(await src.archiveSession('busy', true)).toBe('running');
    await expect(src.archiveSession('no', false)).rejects.toThrow('only the main token archives a session');
    expect(calls[0]).toBe('PATCH http://cockpit.test/api/v0/sessions/c1 {"archived":true}');
    expect(calls[2]).toBe('PATCH http://cockpit.test/api/v0/sessions/no {"archived":false}');
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
