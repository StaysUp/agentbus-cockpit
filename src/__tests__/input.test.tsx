// @vitest-environment jsdom
// The message box: it grows with its text, wrapped lines too, up to about
// ten lines and then scrolls inside; the agent picker and Send sit in their
// own row and never overlap, whatever Send's label says. Its styles are
// checked in inputCss.test.ts.
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { DataSource, SavedAgent } from '../types';
import { ev, flush, liveReplay, render } from './helpers';

const SAVED: SavedAgent[] = [{ id: 'claude', name: 'Claude Code', harness: 'claude', access: 'subscription' }];

const events = [
  ev({ seq: 1, session: 's1', kind: 'turn.started', turn: 'T1', text: 'hi', agent: 'claude', agent_id: 'claude', folder: '/w' }),
  ev({ seq: 2, session: 's1', kind: 'model.requested', turn: 'T1', exchange: 'x1' }),
  ev({ seq: 3, session: 's1', kind: 'model.responded', turn: 'T1', exchange: 'x1', status: 200, text: 'ok' }),
  ev({ seq: 4, session: 's1', kind: 'turn.completed', turn: 'T1', exchange: 'x1', outcome: 'finished' }),
];

function source(): DataSource {
  const base = liveReplay(events).source;
  return {
    ...base,
    getSessions: async () => (await base.getSessions()).map((s) => ({ ...s, resumable: true })),
    subscribe: (cb, snap) => base.subscribe!(cb, (list, c) => snap?.(list.map((s) => ({ ...s, resumable: true })), c)),
    listAgents: async () => SAVED,
    sendMessage: async (id: string) => ({ session: id, turn: 'T2', state: 'running' as const }),
  };
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

async function type(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
afterEach(() => {
  if (scrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeight);
});

describe('the message box', () => {
  it('starts one line high and takes the height of its text, wrapped lines included', async () => {
    // jsdom lays nothing out: the text's height is given, 20px a line.
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        const v = (this as HTMLTextAreaElement).value ?? '';
        return 20 * Math.max(1, Math.ceil(v.length / 40));
      },
    });
    const r = await render(<App dataSource={source()} />);
    await waitFor(() => r.container.querySelector('#c-reply .next-agent') !== null);
    const input = r.container.querySelector('#input') as HTMLTextAreaElement;
    expect(input.rows).toBe(1);
    expect(input.style.height).toBe('20px');
    // One long line with no newline wraps to three lines.
    await type(input, 'x'.repeat(110));
    await flush();
    expect(input.style.height).toBe('60px');
    r.unmount();
  });

  it('puts the agent picker and Send in one row after the text, in that order', async () => {
    const r = await render(<App dataSource={source()} />);
    await waitFor(() => r.container.querySelector('#c-reply .next-agent') !== null);
    const form = r.container.querySelector('#c-reply form')!;
    const row = form.querySelector(':scope > .box-row')!;
    expect(row).not.toBeNull();
    expect(row.previousElementSibling!.id).toBe('input');
    expect(row.querySelector('.next-agent-at')!.nextElementSibling!.className).toBe('go-split');
    r.unmount();
  });
});
