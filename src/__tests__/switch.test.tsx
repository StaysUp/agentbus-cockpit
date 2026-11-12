// @vitest-environment jsdom
// Switching agent per message: a picker beside Send, each turn's agent in
// its header, and a mixed session listed under its first agent.
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { QueueSource } from '../data/jobs';
import { buildAgents, createEmptyUsage } from '../data/turns';
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
    getSessions: async (a) => resumable(await base.source.getSessions(a)),
    subscribe: (cb, snap) => base.source.subscribe!(cb, (list, c) => snap?.(resumable(list), c)),
    listAgents: async () => SAVED,
    sendMessage,
  };
  return { src, sendMessage };
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

  it('keeps a session whose agent is not saved in the list, by its harness name', async () => {
    const events = mixed().map((e) => (e.turn === 'T2' && e.kind === 'turn.started' ? { ...e, agent_id: 'a_gone' } : e));
    const { src } = source(events);
    const r = await render(<App dataSource={src} />);
    await waitFor(() => r.container.querySelector('#c-reply .next-agent') !== null, 'the picker');
    const pick = r.container.querySelector('#c-reply .next-agent') as HTMLButtonElement;
    expect(pick.value).toBe('a_gone');
    expect((await optionsOf(r.container, 'next_agent'))[0][1]).toBe('Codex');
    r.unmount();
  });

  // A conversation keeps no agent of its own: a message names the box's
  // agent even when it is no longer saved, and the service's refusal ("was
  // removed, pick another") shows on the message.
  it('names the box\'s agent even when it was removed, and shows the service\'s words', async () => {
    const events = mixed().map((e) => (e.turn === 'T2' && e.kind === 'turn.started' ? { ...e, agent_id: 'a_gone' } : e));
    const { src, sendMessage } = source(events);
    sendMessage.mockImplementation(async () => {
      throw new Error('agent "a_gone" was removed; pick another (GET /api/v0/agents lists them)');
    });
    const r = await render(<App dataSource={src} />);
    await waitFor(() => r.container.querySelector('#c-reply .next-agent') !== null, 'the picker');
    await send(r.container, 'still there?');
    await waitFor(() => sendMessage.mock.calls.length === 1, 'the send');
    expect((sendMessage.mock.calls[0] as unknown[])[1]).toMatchObject({ agent: 'a_gone', prompt: 'still there?' });
    await waitFor(() => (r.container.textContent ?? '').includes('was removed; pick another'), 'the refusal');
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

describe('a mixed session in the Agents column', () => {
  it('is listed under its first agent', () => {
    const row = (id: string, agent: string, first?: string): SessionSummary => ({
      id,
      agent,
      first_agent: first,
      client: '',
      title: id,
      started: '',
      last: '',
      open: false,
      turns: 1,
      usage: createEmptyUsage(),
    });
    const groups = buildAgents([row('s1', 'codex', 'claude'), row('s2', 'claude', 'claude'), row('s3', 'codex')]);
    expect(groups.map((g) => [g.id, g.sessionCount])).toEqual([
      ['claude', 2],
      ['codex', 1],
    ]);
  });
});
