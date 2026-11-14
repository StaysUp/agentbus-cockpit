import React from 'react';
import { PlanReading, SavedAgent, SubscriptionList } from '../types';

// How much of an agent's own plan is left, as one quiet bar and one line:
// "5-hour limit · 62% left · resets 14:20". It comes from the subscription
// control keeps for the agent's harness (GET /api/v0/subscriptions, usage),
// which the vendor reports on each model reply: claude and codex do. An
// agent with no reading yet shows nothing.

// planOf is the window to show for agent: the one with the least left,
// since that is the one that stops it. Undefined when there is none.
export function planOf(agent: SavedAgent, subs: SubscriptionList | null | undefined): PlanReading | undefined {
  if (agent.access !== 'subscription' || !subs) return undefined;
  const usage = subs.subscriptions.find((s) => s.harness === agent.harness && s.connected)?.usage;
  if (!usage || usage.length === 0) return undefined;
  // The API lists the shortest window first, so a tie keeps it.
  return usage.reduce((a, b) => (b.used_percent > a.used_percent ? b : a));
}

// windowLabel names a window by its length: "5-hour limit", "Weekly limit".
export function windowLabel(p: PlanReading): string {
  const m = p.window_minutes;
  if (!m) return `${p.window} limit`;
  if (m === 7 * 24 * 60) return 'Weekly limit';
  if (m % (24 * 60) === 0) return `${m / (24 * 60)}-day limit`;
  if (m % 60 === 0) return `${m / 60}-hour limit`;
  return `${m}-minute limit`;
}

// percentLeft is what is left of the window, 0 to 100, whole.
export function percentLeft(p: PlanReading): number {
  return Math.max(0, Math.min(100, Math.round(100 - p.used_percent)));
}

const hm = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

// when is a time as the line says it: "14:20" today, "Fri 14:20" within a
// week, else "Nov 21".
export function when(d: Date, now: Date): string {
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(now)) / 86400000);
  if (days === 0) return hm(d);
  if (Math.abs(days) < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${hm(d)}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// stale says the reading may no longer hold: its window reset since, or it
// is older than a tenth of its window (an hour when the length is unknown).
// No model call on the subscription since then would have updated it.
export function stale(p: PlanReading, now: Date): boolean {
  if (p.resets_at && new Date(p.resets_at).getTime() <= now.getTime()) return true;
  const span = (p.window_minutes || 600) * 60000;
  return now.getTime() - new Date(p.read_at).getTime() > span / 10;
}

// planLine is the line under the bar.
export function planLine(p: PlanReading, now: Date): string {
  const parts = [windowLabel(p), `${percentLeft(p)}% left`];
  if (p.resets_at && new Date(p.resets_at).getTime() > now.getTime()) parts.push(`resets ${when(new Date(p.resets_at), now)}`);
  if (stale(p, now)) parts.push(`as of ${when(new Date(p.read_at), now)}`);
  return parts.join(' · ');
}

export const PlanUsage: React.FC<{ plan: PlanReading | undefined; now?: Date }> = ({ plan, now = new Date() }) => {
  if (!plan) return null;
  const left = percentLeft(plan);
  return (
    <>
      <span className="quota" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-label={`${windowLabel(plan)}: ${left}% left`}>
        <i style={{ width: `${left}%` }} />
      </span>
      <span className="q-l plan-line">{planLine(plan, now)}</span>
    </>
  );
};
