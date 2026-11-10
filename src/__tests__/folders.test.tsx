// @vitest-environment jsdom
// Step 2 and 3 of the framework's API: folders by reference (GET
// /api/v0/folders, turn.started folder_ref) and apply up to a turn.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveDataSource } from '../data/LiveDataSource';
import { FoldersContext, folderLabel, sessionFolderRef } from '../data/folders';
import { SessionPanel } from '../components/SessionPanel';
import { buildTurns } from '../data/turns';
import { SessionDetail } from '../types';
import { ev, render } from './helpers';

const BASE = 'http://cockpit.test';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

const folders = [{ ref: 'fld_3f1c0a9b2e4d5f60', name: 'shop', connector: 'con_8a7b6c5d4e3f2a10', runner: 'run_1' }];

describe('folders by reference', () => {
  it('names a folder by its reference when the API lists it, else by its path', () => {
    expect(folderLabel('/work/remote-runner/worktrees/s1', 'fld_3f1c0a9b2e4d5f60', folders)).toBe('shop');
    expect(folderLabel('/Users/me/shop', undefined, folders)).toBe('/Users/me/shop');
    expect(folderLabel('/Users/me/shop', 'fld_0000000000000000', folders)).toBe('/Users/me/shop');
    expect(folderLabel(undefined, undefined, folders)).toBeUndefined();
  });

  it("takes a session's reference from its row, else from its latest turn", () => {
    expect(sessionFolderRef({ folder_ref: 'fld_a', turnsList: [{ folderRef: 'fld_b' }] })).toBe('fld_a');
    expect(sessionFolderRef({ turnsList: [{ folderRef: 'fld_b' }, {}] })).toBe('fld_b');
    expect(sessionFolderRef({ turnsList: [] })).toBeUndefined();
  });

  it("reads turn.started's folder_ref onto the turn", () => {
    const turns = buildTurns('abc', [
      ev({ seq: 1, session: 'abc', kind: 'turn.started', turn: 'T1', agent: 'claude', folder: '/copy', folder_ref: 'fld_3f1c0a9b2e4d5f60', text: 'hi' }),
    ]);
    expect(turns[0].folder).toBe('/copy');
    expect(turns[0].folderRef).toBe('fld_3f1c0a9b2e4d5f60');
  });

  it('lists the folders from GET /api/v0/folders', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return json({ folders });
    });
    expect(await new LiveDataSource({ baseUrl: BASE, token: 't' }).listFolders()).toEqual(folders);
    expect(urls).toEqual([`${BASE}/api/v0/folders`]);
  });

  it('the session panel shows the folder name for a session on a remote runner', async () => {
    const session: SessionDetail = {
      id: 'abc',
      agent: 'claude',
      client: '',
      folder: '/work/remote-runner/worktrees/abc',
      title: 't',
      started: '2026-11-10T09:00:00Z',
      last: '2026-11-10T09:00:01Z',
      open: false,
      turns: 1,
      usage: { input_tokens: 0, output_tokens: 0 },
      turnsList: buildTurns('abc', [
        ev({ seq: 1, session: 'abc', kind: 'turn.started', turn: 'T1', agent: 'claude', folder_ref: 'fld_3f1c0a9b2e4d5f60', text: 'hi' }),
      ]),
    };
    const { container, unmount } = await render(
      <FoldersContext.Provider value={folders}>
        <SessionPanel session={session} agentName="claude" onSelectTurn={() => undefined} />
      </FoldersContext.Provider>
    );
    const kvs = container.querySelector('.sess-kvs')?.textContent ?? '';
    expect(kvs).toContain('shop');
    expect(kvs).not.toContain('/work/remote-runner');
    unmount();
  });
});

describe('apply up to a turn', () => {
  it('answers a refusal on 409, and an apply still running elsewhere as an error in the API words', async () => {
    const refused = { state: 'refused', error: 'a file in your folder changed', conflicts: [{ path: 'a.txt', why: 'changed' }] };
    let reply: Response = json(refused, 409);
    vi.stubGlobal('fetch', async () => reply);
    const src = new LiveDataSource({ baseUrl: BASE, token: 't' });
    expect(await src.applyTurn('T2')).toEqual(refused);
    reply = json({ error: 'an apply of an earlier turn of this session has not ended; ask again once it has' }, 409);
    await expect(src.applyTurn('T2')).rejects.toThrow('an apply of an earlier turn of this session has not ended');
  });
});
