// @vitest-environment jsdom
// What is left of each agent's own plan, under its name in the Agents
// column, from the subscription's usage (GET /api/v0/subscriptions): one
// quiet bar for the longest window, its words in the bar's tooltip, and the
// line "5h · 62% left · 14:20" for the shortest. Nothing
// without a reading. A subscription agent's turn end reads it again.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { AgentsColumn } from '../components/AgentsColumn';
import { planLine, shortLabel, shortLine, stale, usageOf, windowLabel } from '../components/PlanUsage';
import { CockpitEvent, DataSource, PlanReading, SavedAgent, SubscriptionList } from '../types';
import { ev, liveReplay, render, unmountAll } from './helpers';

// Local times, so the line reads the same in every time zone.
const now = new Date(2026, 10, 14, 10, 0);
const iso = (d: Date) => d.toISOString();
const minutes = (n: number) => new Date(now.getTime() + n * 60000);

const fiveHour: PlanReading = {
  window: '5h', window_minutes: 300, used_percent: 38, status: 'allowed',
  resets_at: iso(new Date(2026, 10, 14, 14, 20)), read_at: iso(minutes(-2)),
};
const weekly: PlanReading = {
  window: '7d', window_minutes: 10080, used_percent: 69, status: 'allowed',
  resets_at: iso(new Date(2026, 10, 20, 9, 0)), read_at: iso(minutes(-2)),
};

const claude: SavedAgent = { id: 'claude', name: 'Claude Code', harness: 'claude', access: 'subscription' };
const codex: SavedAgent = { id: 'codex', name: 'Codex', harness: 'codex', access: 'subscription' };

const subs = (usage?: PlanReading[]): SubscriptionList => ({
  subscriptions: [
    { harness: 'claude', connected: true, expired: false, usage },
    { harness: 'codex', connected: true, expired: false },
  ],
});

afterEach(() => {
  unmountAll();
  document.body.innerHTML = '';
});

describe('the plan line', () => {
  it('names the window, what is left and when it resets', () => {
    expect(planLine({ ...fiveHour, used_percent: 38 }, now)).toBe('5-hour limit · 62% left · resets 14:20');
    expect(shortLine({ ...fiveHour, used_percent: 38 }, now)).toBe('5h · 62% left · 14:20');
    expect(shortLabel({ ...fiveHour, window_minutes: 7 * 24 * 60 })).toBe('7d');
    expect(planLine(weekly, now)).toBe('Weekly limit · 31% left · resets Fri 09:00');
  });
  it('names other windows by their length, or by the vendor when it gave none', () => {
    expect(windowLabel({ ...fiveHour, window_minutes: 60 })).toBe('1-hour limit');
    expect(windowLabel({ ...fiveHour, window_minutes: 2880 })).toBe('2-day limit');
    expect(windowLabel({ ...fiveHour, window_minutes: 90 })).toBe('90-minute limit');
    expect(windowLabel({ ...fiveHour, window: 'primary', window_minutes: undefined })).toBe('primary limit');
  });
  it('never shows less than 0% or more than 100% left', () => {
    expect(planLine({ ...fiveHour, used_percent: 104 }, now)).toMatch(/· 0% left ·/);
    expect(planLine({ ...fiveHour, used_percent: 0 }, now)).toMatch(/· 100% left ·/);
  });
  it('says "as of" once the reading is older than a tenth of its window, or its window reset since', () => {
    expect(stale({ ...fiveHour, read_at: iso(minutes(-29)) }, now)).toBe(false);
    const old = { ...fiveHour, read_at: iso(minutes(-31)) };
    expect(stale(old, now)).toBe(true);
    expect(planLine(old, now)).toBe('5-hour limit · 62% left · resets 14:20 · as of 09:29');
    const reset = { ...fiveHour, resets_at: iso(minutes(-1)) };
    expect(planLine(reset, now)).toBe('5-hour limit · 62% left · as of 09:58');
    // A week's reading holds longer.
    expect(stale({ ...weekly, read_at: iso(minutes(-600)) }, now)).toBe(false);
  });
});

describe('usageOf', () => {
  it('lists the readings shortest window first, one of unknown length last', () => {
    const odd = { ...fiveHour, window: 'primary', window_minutes: undefined };
    expect(usageOf(claude, subs([weekly, odd, fiveHour]))?.map((p) => p.window)).toEqual(['5h', '7d', 'primary']);
  });
  it('is nothing before a reading, for a harness not connected, or for another access', () => {
    expect(usageOf(claude, subs())).toBeUndefined();
    expect(usageOf(claude, subs([]))).toBeUndefined();
    expect(usageOf(codex, subs([fiveHour]))).toBeUndefined();
    expect(usageOf(claude, undefined)).toBeUndefined();
    expect(usageOf({ ...claude, access: 'api' }, subs([fiveHour]))).toBeUndefined();
    const off: SubscriptionList = { subscriptions: [{ harness: 'claude', connected: false, expired: false, usage: [fiveHour] }] };
    expect(usageOf(claude, off)).toBeUndefined();
  });
});

const rowOf = (c: HTMLElement, id: string) => c.querySelector(`[data-agent="${id}"]`)!;
const barOf = (row: Element) => row.querySelector('.quota') as HTMLElement;

describe('the Agents column', () => {
  it('shows the longest window on the bar, in its tooltip, and the shortest on the line', async () => {
    const r = await render(
      <AgentsColumn agents={[claude, codex]} selectedAgentId={null} onSelectAgent={() => undefined} subscriptions={subs([fiveHour, weekly])} />
    );
    const row = rowOf(r.container, 'claude');
    const bar = barOf(row);
    expect(bar.getAttribute('aria-valuenow')).toBe('31');
    expect((bar.querySelector('i') as HTMLElement).style.width).toBe('31%');
    expect(bar.getAttribute('title')).toMatch(/^Weekly limit · 31% left · resets \w+ \d\d:\d\d$/);
    expect(bar.getAttribute('aria-label')).toBe(bar.getAttribute('title'));
    expect(row.querySelector('.plan-line')?.textContent).toMatch(/^5h · 62% left · \d\d:\d\d$/);
    const other = rowOf(r.container, 'codex');
    expect(other.querySelector('.quota')).toBeNull();
    expect(other.querySelector('.plan-line')).toBeNull();
  });
  it('shows one window on the bar only, its words on hover', async () => {
    const r = await render(
      <AgentsColumn agents={[claude]} selectedAgentId={null} onSelectAgent={() => undefined} subscriptions={subs([weekly])} />
    );
    const row = rowOf(r.container, 'claude');
    expect(barOf(row).getAttribute('aria-valuenow')).toBe('31');
    expect(barOf(row).getAttribute('title')).toMatch(/^Weekly limit · 31% left/);
    expect(row.querySelector('.plan-line')).toBeNull();
  });
  it("puts 'as of' in the tooltip when the bar's reading is stale", async () => {
    const old = { ...weekly, read_at: new Date(Date.now() - 20 * 3600000).toISOString(), resets_at: new Date(Date.now() + 86400000).toISOString() };
    const r = await render(
      <AgentsColumn agents={[claude]} selectedAgentId={null} onSelectAgent={() => undefined} subscriptions={subs([old])} />
    );
    expect(barOf(rowOf(r.container, 'claude')).getAttribute('title')).toMatch(/ · as of /);
  });
});

// The cockpit reads the subscriptions again when a subscription agent's
// turn ends, not only once a minute; an API-key agent's turn end does not.
describe("reading usage at a turn's end", () => {
  const turn = (session: string, t: string, access?: string): CockpitEvent[] => [
    ev({ session, kind: 'turn.started', turn: t, text: 'hi', agent: 'claude', agent_id: 'claude', folder: '/w', ...(access ? { access } : {}) }),
    ev({ session, kind: 'model.requested', turn: t, exchange: `x-${t}`, model: 'm' }),
    ev({ session, kind: 'model.responded', turn: t, exchange: `x-${t}`, status: 200, text: 'ok', stop_reason: 'end_turn' }),
  ];
  const done = (session: string, t: string) => ev({ session, kind: 'turn.completed', turn: t, exchange: `x-${t}`, outcome: 'finished' });

  async function settle(check: () => boolean, what: string) {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    throw new Error('timed out waiting for ' + what);
  }

  it("reads again on a subscription turn's turn.completed, and not on an API-key one's", async () => {
    const live = liveReplay([]);
    const listSubscriptions = vi.fn(async () => subs([fiveHour]));
    const src: DataSource = { ...live.source, listAgents: async () => [claude], listSubscriptions };
    const r = await render(<App dataSource={src} />);
    await settle(() => listSubscriptions.mock.calls.length >= 1, 'the first read');
    await settle(() => r.container.querySelector('#agents .quota') !== null, 'the bar');
    const before = listSubscriptions.mock.calls.length;

    // An API-key agent's turn: no read.
    for (const e of turn('s2', 'T2', 'api')) await act(async () => live.push(e));
    await act(async () => live.push(done('s2', 'T2')));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(listSubscriptions.mock.calls.length).toBe(before);

    // A subscription agent's turn: read at its end.
    for (const e of turn('s1', 'T1')) await act(async () => live.push(e));
    expect(listSubscriptions.mock.calls.length).toBe(before);
    await act(async () => live.push(done('s1', 'T1')));
    await settle(() => listSubscriptions.mock.calls.length === before + 1, 'a read at the turn end');
  });
});
