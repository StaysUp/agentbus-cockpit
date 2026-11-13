// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { click, ev, flush, jsonl, render, unmountAll } from './helpers';

// Two sessions, each with one finished turn.
function source() {
  const evs = ['a', 'b'].flatMap((s) => [
    ev({ session: s, kind: 'session.registered', agent: 'claude', folder: '/w' }),
    ev({ session: s, kind: 'turn.started', turn: `T-${s}`, exchange: `x-${s}`, text: `prompt ${s}` }),
    ev({ session: s, kind: 'model.requested', turn: `T-${s}`, exchange: `x-${s}` }),
    ev({ session: s, kind: 'model.responded', turn: `T-${s}`, exchange: `x-${s}`, status: 200, text: `reply ${s}` }),
    ev({ session: s, kind: 'turn.completed', turn: `T-${s}`, exchange: `x-${s}`, outcome: 'finished' }),
  ]);
  return new ReplayDataSource(jsonl(evs));
}

// A window as wide as `narrow` says: matchMedia answers the cockpit's one query.
function setNarrow(narrow: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: narrow && query === '(max-width: 900px)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

// The browser's Back: jsdom sends popstate on a later task.
async function browserBack() {
  await act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 20));
  });
}

// Wait for a popstate the cockpit's own back button caused.
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

const app = (c: HTMLElement) => c.querySelector('#app') as HTMLElement;
const column = (c: HTMLElement) => app(c).dataset.column;

beforeEach(() => window.history.replaceState(null, '', '/'));
afterEach(() => {
  unmountAll();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('narrow screen: one column at a time', () => {
  it('opens Sessions, then the conversation, then the turn, and back buttons and browser Back step back', async () => {
    setNarrow(true);
    const r = await render(<App dataSource={source()} />);
    await flush();
    await flush();
    const c = r.container;
    expect(column(c)).toBe('sessions');
    // Every card is a button, the one open before included.
    const cards = c.querySelectorAll('#sessions button.sess');
    expect(cards).toHaveLength(2);

    await click(cards[1]);
    await flush();
    expect(column(c)).toBe('convo');
    expect(window.history.state).toEqual({ column: 'convo' });
    expect(window.location.pathname).toBe('/');

    await click(c.querySelector('#convo .tb.pick'));
    await flush();
    expect(column(c)).toBe('turn');
    expect(app(c).classList.contains('panel')).toBe(true);
    expect(window.history.state).toEqual({ column: 'turn' });

    // The panel's back button is the browser's Back.
    await click(c.querySelector('#p-head .col-back'));
    await settle();
    expect(column(c)).toBe('convo');
    expect(app(c).classList.contains('panel')).toBe(false);

    // Forward again, then the browser's own Back twice.
    await click(c.querySelector('#convo .tb.pick'));
    await flush();
    expect(column(c)).toBe('turn');
    await browserBack();
    expect(column(c)).toBe('convo');
    await browserBack();
    expect(column(c)).toBe('sessions');

    // The conversation's back button goes to Sessions.
    await click(c.querySelectorAll('#sessions button.sess')[0]);
    await flush();
    expect(column(c)).toBe('convo');
    await click(c.querySelector('#c-head .col-back'));
    await settle();
    expect(column(c)).toBe('sessions');
  });

  it('Esc closes the turn column as Back does', async () => {
    setNarrow(true);
    const r = await render(<App dataSource={source()} />);
    await flush();
    await flush();
    const c = r.container;
    await click(c.querySelectorAll('#sessions button.sess')[0]);
    await flush();
    await click(c.querySelector('#convo .tb.pick'));
    await flush();
    expect(column(c)).toBe('turn');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise((res) => setTimeout(res, 20));
    });
    expect(column(c)).toBe('convo');
    expect(window.history.state).toEqual({ column: 'convo' });
  });

  it('shows Agents as a menu that closes on a pick, on the backdrop or on Esc', async () => {
    setNarrow(true);
    const r = await render(<App dataSource={source()} />);
    await flush();
    const c = r.container;
    expect(app(c).classList.contains('agents-open')).toBe(false);
    await click(c.querySelector('#sessions .agents-menu'));
    expect(app(c).classList.contains('agents-open')).toBe(true);
    await click(c.querySelector('.agents-scrim'));
    expect(app(c).classList.contains('agents-open')).toBe(false);
    await click(c.querySelector('#sessions .agents-menu'));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(app(c).classList.contains('agents-open')).toBe(false);
  });
});

describe('wide screen', () => {
  it('adds no history entry: a session and a turn open in place, and × closes the panel', async () => {
    setNarrow(false);
    const r = await render(<App dataSource={source()} />);
    await flush();
    await flush();
    const c = r.container;
    const before = window.history.length;
    await click(c.querySelector('#sessions button.sess'));
    await flush();
    await click(c.querySelector('#convo .tb.pick'));
    await flush();
    expect(app(c).classList.contains('panel')).toBe(true);
    expect(window.history.length).toBe(before);
    expect(window.history.state).toBeNull();
    await click(c.querySelector('#p-head .p-close'));
    expect(app(c).classList.contains('panel')).toBe(false);
  });
});
