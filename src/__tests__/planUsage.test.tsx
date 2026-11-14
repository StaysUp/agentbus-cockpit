// @vitest-environment jsdom
// What is left of each agent's own plan, under its name in the Agents
// column: "5-hour limit · 62% left · resets 14:20" over one quiet bar, from
// the subscription's usage (GET /api/v0/subscriptions). Nothing without a
// reading.
import { afterEach, describe, expect, it } from 'vitest';
import { AgentsColumn } from '../components/AgentsColumn';
import { planLine, planOf, stale, windowLabel } from '../components/PlanUsage';
import { PlanReading, SavedAgent, SubscriptionList } from '../types';
import { render, unmountAll } from './helpers';

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

describe('planOf', () => {
  it('shows the window with the least left', () => {
    expect(planOf(claude, subs([fiveHour, weekly]))?.window).toBe('7d');
    expect(planOf(claude, subs([{ ...fiveHour, used_percent: 80 }, weekly]))?.window).toBe('5h');
  });
  it('is nothing before a reading, for a harness not connected, or for another access', () => {
    expect(planOf(claude, subs())).toBeUndefined();
    expect(planOf(claude, subs([]))).toBeUndefined();
    expect(planOf(codex, subs([fiveHour]))).toBeUndefined();
    expect(planOf(claude, undefined)).toBeUndefined();
    expect(planOf({ ...claude, access: 'api' }, subs([fiveHour]))).toBeUndefined();
    const off: SubscriptionList = { subscriptions: [{ harness: 'claude', connected: false, expired: false, usage: [fiveHour] }] };
    expect(planOf(claude, off)).toBeUndefined();
  });
});

describe('the Agents column', () => {
  it('shows the bar and the line under an agent with a reading, and nothing under one without', async () => {
    const r = await render(
      <AgentsColumn agents={[claude, codex]} selectedAgentId={null} onSelectAgent={() => undefined} subscriptions={subs([fiveHour])} />
    );
    const row = r.container.querySelector('[data-agent="claude"]')!;
    const bar = row.querySelector('.quota') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.getAttribute('aria-valuenow')).toBe('62');
    expect((bar.querySelector('i') as HTMLElement).style.width).toBe('62%');
    expect(row.querySelector('.plan-line')?.textContent).toMatch(/^5-hour limit · 62% left · resets \d\d:\d\d$/);
    const other = r.container.querySelector('[data-agent="codex"]')!;
    expect(other.querySelector('.quota')).toBeNull();
    expect(other.querySelector('.plan-line')).toBeNull();
  });
});
