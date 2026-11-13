// @vitest-environment jsdom
// Switching agent per message: a picker beside Send, each turn's agent in
// its header, and the agents a mixed session names in its row.
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { QueueSource } from '../data/jobs';
import { createEmptyUsage, sessionAgents } from '../data/turns';
import { CockpitEvent, DataSource, SavedAgent, SessionSummary } from '../types';
import { choose, click, ev, flush, liveReplay, optionsOf, render } from './helpers';

const SAVED: SavedAgent[] = [
  { id: 'claude', name: 'Claude Code', harness: 'claude', access: 'subscription' },
  { id: 'a_haiku', name: 'Claude Code · haiku', harness: 'claude', access: 'subscription', model: 'haiku' },
  { id: 'codex', name: 'Codex', harness: 'codex', access: 'subscription' },
];

// Turn 1 on the haiku agent, turn 2 on codex.
function mixed(session = 's1'): CockpitEvent[] {
  const turn = (t: string, text: string, agent: string, agentId: string, reply: string) => [
    ev({ session, kind: 'turn.started', turn: t, text, agent, agent_id: agentId, folder: '/w' }),
    ev({ session, kind: 'model.requested', turn: t, exchange: `x-${t}`, model: agent === 'claude' ? 'claude-haiku' : 'gpt-x' }),
    ev({ session, kind: 'model.responded', turn: t, exchange: `x-${t}`, status: 200, text: reply, stop_reason: 'end_turn' }),
    ev({ session, kind: 'turn.completed', turn: t, exchange: `x-${t}`, outcome: 'finished' }),
  ];
  return [...turn('T1', 'remember OSPREY', 'claude', 'a_haiku', 'OK'), ...turn('T2', 'which bird?', 'codex', 'codex', 'OSPREY')];
}

function source(events: CockpitEvent[]) {
  const base = liveReplay(events);
  const resumable = <T extends { resumable?: boolean }>(list: T[]) => list.map((s) => ({ ...s, resumable: true }));
  const sendMessage = vi.fn(async (id: string) => ({ session: id, turn: 'Tnext', state: 'running' as const }));
  const src: DataSource = {
    ...base.source,
    getSessions: async () => resumable(await base.source.getSessions()),
    subscribe: (cb, snap) => base.source.subscribe!(cb, (list, c) => snap?.(resumable(list), c)),
    listAgents: async () => SAVED,
    sendMessage,
  };
  return { src, sendMessage, push: base.push };
}

async function waitFor(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error('timed out waiting for ' + what);
}

async function setValue(el: Element | null, value: string) {
  if (!el) throw new Error('no field');
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

async function send(c: HTMLElement, text: string) {
  await setValue(c.querySelector('#c-reply textarea'), text);
  await act(async () => {
    c.querySelector('#c-reply form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
}

describe('switching agent per message', () => {
  it('names the agent of each turn in its header', async () => {
    const { src } = source(mixed());
    const r = await render(<App dataSource={src} />);
    await waitFor(() => r.container.querySelectorAll('#convo .tb-agent').length === 2, 'the turns');
    const names = [...r.container.querySelectorAll('#convo .tb-agent')].map((x) => x.textContent);
    expect(names).toEqual(['Claude Code · haiku', 'Codex']);
    r.unmount();
  });

  it('offers the saved agents beside Send, on the latest turn’s agent, and sends a picked one', async () => {
    const { src, sendMessage } = source(mixed());
    const r = await render(<App dataSource={src} />);
    await waitFor(() => r.container.querySelector('#c-reply .next-agent') !== null, 'the picker');
    const pick = r.container.querySelector('#c-reply .next-agent') as HTMLButtonElement;
    expect((await optionsOf(r.container, 'next_agent')).map((o) => o[1])).toEqual(['Claude Code', 'Claude Code · haiku', 'Codex']);
    expect(pick.value).toBe('codex');
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).placeholder).toBe('Message Codex…');

    // The same agent is named too: every message names the agent in the
    // box, which starts as the conversation's last.
    await send(r.container, 'one more');
    await waitFor(() => sendMessage.mock.calls.length === 1, 'the first send');
    expect(sendMessage.mock.calls[0]).toEqual(['s1', { prompt: 'one more', read_only: false, agent: 'codex', idempotency_key: expect.stringMatching(/^cockpit-msg-/) }]);

    r.unmount();
  });

  it('sends the picked agent when it differs from the session’s', async () => {
    const { src, sendMessage } = source(mixed());
    const r = await render(<App dataSource={src} />);
    await waitFor(() => r.container.querySelector('#c-reply .next-agent') !== null, 'the picker');
    await choose(r.container, 'next_agent', 'a_haiku');
    expect((r.container.querySelector('#c-reply textarea') as HTMLTextAreaElement).placeholder).toBe('Message Claude Code · haiku…');
    await send(r.container, 'back to haiku');
    await waitFor(() => sendMessage.mock.calls.length === 1, 'the send');
    expect(sendMessage.mock.calls[0]).toEqual(['s1', { prompt: 'back to haiku', read_only: false, agent: 'a_haiku', idempotency_key: expect.stringMatching(/^cockpit-msg-/) }]);
    r.unmount();
  });

  it('sends the picked agent through POST /api/v0/turns when the service keeps a queue', async () => {
    const { src, sendMessage } = source(mixed());
    const reviews: string[] = [];
    const queue: QueueSource = {
      address: 'http://agentbus.test',
      pollMs: 10,
      listTurns: async () => [],
      review: async (id) => {
        reviews.push(id);
        return { session: 'r1', turn: 'R1', state: 'queued' };
      },
      stop: async () => undefined,
    };
    const r = await render(<App dataSource={src} queue={queue} />);
    await waitFor(() => r.container.querySelector('#c-reply .next-agent') !== null, 'the picker');
    await choose(r.container, 'next_agent', 'a_haiku');
    await send(r.container, 'back to haiku');
    // With a queue too, a message is POST /api/v0/turns: the one path.
    await waitFor(() => sendMessage.mock.calls.length === 1, 'the send');
    expect((sendMessage.mock.calls[0] as unknown[])[1]).toMatchObject({ agent: 'a_haiku', prompt: 'back to haiku' });
    expect(reviews).toHaveLength(0);
    r.unmount();
  });

  it('drops a pick whose agent was removed, and sends the session’s own', async () => {
    const { src, sendMessage } = source(mixed());
    let list = SAVED;
    src.listAgents = async () => list;
    src.getHarnesses = async () => [{ name: 'claude', found: true }, { name: 'codex', found: true }];
    src.createAgent = async () => SAVED[0];
    const r = await render(<App dataSource={src} />);
    await waitFor(() => r.container.querySelector('#c-reply .next-agent') !== null, 'the picker');
    await choose(r.container, 'next_agent', 'a_haiku');
    // The agent is removed; the list is read again when the agents form closes.
    list = SAVED.filter((a) => a.id !== 'a_haiku');
    await act(async () => {
      r.container.querySelector<HTMLButtonElement>('#agents .add-agent')!.click();
    });
    await flush();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await waitFor(() => (r.container.querySelector('#c-reply .next-agent') as HTMLButtonElement).value === 'codex', 'the new list');
    expect((await optionsOf(r.container, 'next_agent')).length).toBe(2);
    await send(r.container, 'still here?');
    await waitFor(() => sendMessage.mock.calls.length === 1, 'the send');
    expect((sendMessage.mock.calls[0] as unknown[])[1]).toEqual({ prompt: 'still here?', read_only: false, agent: 'codex', idempotency_key: expect.stringMatching(/^cockpit-msg-/) });
    r.unmount();
  });

  // The box holds only a saved agent: a session whose last agent was removed
  // starts on none, and Send waits for a pick.
  it('a session whose last agent was removed starts with an empty box, and Send waits for a pick', async () => {
    const events = mixed().map((e) => (e.turn === 'T2' && e.kind === 'turn.started' ? { ...e, agent_id: 'a_gone' } : e));
    const { src, sendMessage } = source(events);
    const r = await render(<App dataSource={src} />);
    await waitFor(() => r.container.querySelector('#c-reply .next-agent') !== null, 'the picker');
    const pick = r.container.querySelector('#c-reply .next-agent') as HTMLButtonElement;
    expect(pick.value).toBe('');
    expect(pick.textContent).toContain('Pick an agent');
    expect((await optionsOf(r.container, 'next_agent')).map((o) => o[0])).toEqual(['claude', 'a_haiku', 'codex']);
    await setValue(r.container.querySelector('#c-reply textarea'), 'hi');
    const go = r.container.querySelector('#c-reply button.go') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await send(r.container, 'hi');
    expect(sendMessage).not.toHaveBeenCalled();
    await choose(r.container, 'next_agent', 'codex');
    expect((r.container.querySelector('#c-reply button.go') as HTMLButtonElement).disabled).toBe(false);
    await send(r.container, 'hi');
    await waitFor(() => sendMessage.mock.calls.length === 1, 'the send');
    expect((sendMessage.mock.calls[0] as unknown[])[1]).toMatchObject({ agent: 'codex', prompt: 'hi' });
    r.unmount();
  });

  it('with no saved agent the box says "Add an agent first", which opens the form, and Send waits', async () => {
    const { src, sendMessage } = source(mixed());
    src.listAgents = async () => [];
    src.getHarnesses = async () => [{ name: 'claude', found: true }];
    src.createAgent = async () => SAVED[0];
    const r = await render(<App dataSource={src} />);
    await waitFor(() => r.container.querySelector('#c-reply .add-first') !== null, 'the add button');
    expect(r.container.querySelector('#c-reply .add-first')!.textContent).toBe('Add an agent first');
    await setValue(r.container.querySelector('#c-reply textarea'), 'hi');
    expect((r.container.querySelector('#c-reply button.go') as HTMLButtonElement).disabled).toBe(true);
    await send(r.container, 'hi');
    expect(sendMessage).not.toHaveBeenCalled();
    await click(r.container.querySelector('#c-reply .add-first'));
    await waitFor(() => r.container.querySelector('.agent-form') !== null, 'the agents form');
    r.unmount();
  });

  // An agent removed after the list was read is refused by the service. The
  // refusal names the agent, never its id, and leaves out the API's pointer.
  it('a refusal names the agent, not its id, without the API hint', async () => {
    const { src, sendMessage } = source(mixed());
    sendMessage.mockImplementation(async () => {
      throw new Error('agent "codex" was removed; pick another (GET /api/v0/agents lists them)');
    });
    const r = await render(<App dataSource={src} />);
    await waitFor(() => r.container.querySelector('#c-reply .next-agent') !== null, 'the picker');
    await send(r.container, 'still there?');
    await waitFor(() => !!r.container.querySelector('.tb.pending.failed .form-error'), 'the refusal');
    expect(r.container.querySelector('.tb.pending.failed .form-error')!.textContent).toBe('agent "Codex" was removed; pick another');
    r.unmount();
  });

  // A refused message stays where it was sent, with Edit and Dismiss; a
  // later turn goes below it, never above.
  it('a refused message stays above a later turn, and Dismiss clears it', async () => {
    const { src, sendMessage, push } = source(mixed());
    sendMessage.mockImplementationOnce(async () => {
      throw new Error('agent "codex" was removed; pick another');
    });
    const r = await render(<App dataSource={src} />);
    await waitFor(() => r.container.querySelector('#c-reply .next-agent') !== null, 'the picker');
    await send(r.container, 'hi');
    await waitFor(() => !!r.container.querySelector('.tb.pending.failed'), 'the refusal');
    await choose(r.container, 'next_agent', 'a_haiku');
    await send(r.container, 'hi');
    await waitFor(() => sendMessage.mock.calls.length === 2, 'the second send');
    await act(async () => {
      for (const e of [
        ev({ session: 's1', kind: 'turn.started', turn: 'T3', text: 'hi', agent: 'claude', agent_id: 'a_haiku', folder: '/w' }),
        ev({ session: 's1', kind: 'model.requested', turn: 'T3', exchange: 'x-T3', model: 'claude-haiku' }),
        ev({ session: 's1', kind: 'model.responded', turn: 'T3', exchange: 'x-T3', status: 200, text: 'hello', stop_reason: 'end_turn' }),
        ev({ session: 's1', kind: 'turn.completed', turn: 'T3', exchange: 'x-T3', outcome: 'finished' }),
      ])
        push(e);
    });
    await waitFor(() => r.container.querySelectorAll('#convo .tb-agent').length === 3, 'the new turn');
    const failed = r.container.querySelector('#convo .tb.pending.failed')!;
    expect(failed).not.toBeNull();
    const turns = [...r.container.querySelectorAll('#convo .tb:not(.pending)')];
    const newest = turns[turns.length - 1];
    // The failure comes before the newest turn in the page.
    expect(failed.compareDocumentPosition(newest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(failed.querySelector('.pend-back')?.textContent).toBe('Edit');
    await click(failed.querySelector('.pend-dismiss'));
    expect(r.container.querySelector('#convo .tb.pending.failed')).toBeNull();
    r.unmount();
  });
});

describe('the Send menu', () => {
  it('offers Send and a Fork that is shown but not built yet', async () => {
    const { src } = source(mixed());
    const r = await render(<App dataSource={src} />);
    await waitFor(() => r.container.querySelector('#c-reply .send-mode') !== null, 'the send menu');
    const menu = r.container.querySelector('#c-reply .send-mode') as HTMLButtonElement;
    expect(menu.value).toBe('send');
    await click(menu);
    const opts = [...document.querySelectorAll('[role="listbox"] [role="option"]')] as HTMLButtonElement[];
    expect(opts.map((o) => o.getAttribute('data-value'))).toEqual(['send', 'fork']);
    expect(opts[1].disabled).toBe(true);
    expect(opts[1].textContent).toContain('coming soon');
    await click(menu);
    r.unmount();
  });
});

describe('the agents that took part in a session', () => {
  const row = (agent: string, first?: string, firstId?: string): SessionSummary => ({
    id: 's',
    agent,
    first_agent: first,
    ...(firstId ? { first_agent_id: firstId } : {}),
    client: '',
    title: 's',
    started: '',
    last: '',
    open: false,
    turns: 2,
    usage: createEmptyUsage(),
  });
  const saved = [{ id: 'a_haiku', name: 'Claude Code · haiku', harness: 'claude', access: 'subscription' }];

  it('a session that switched agents lists both, first then latest', () => {
    expect(sessionAgents(row('codex', 'claude'))).toEqual(['Claude Code', 'Codex']);
    expect(sessionAgents(row('codex', 'claude', 'a_haiku'), saved)).toEqual(['Claude Code · haiku', 'Codex']);
  });

  it('a session on one agent lists it once', () => {
    expect(sessionAgents(row('claude', 'claude', 'a_haiku'), saved)).toEqual(['Claude Code · haiku']);
    expect(sessionAgents(row('codex'))).toEqual(['Codex']);
  });

  it('a saved agent since removed is named by its harness, never as a removed agent', () => {
    expect(sessionAgents(row('claude', 'claude', 'a_gone'), saved)).toEqual(['Claude Code']);
  });
});
