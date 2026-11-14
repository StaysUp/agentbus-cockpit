import React from 'react';
import { PlanReading, SavedAgent, SubscriptionList } from '../types';

// How much of an agent's own plan is left, as one quiet bar and one line.
// The bar is the longest window (such as the week), with its words in the
// bar's tooltip; the line is the shortest (such as "5h · 62% left
// · 14:20"). With one window, only the bar shows. It comes from the
// subscription control keeps for the agent's harness (GET
// /api/v0/subscriptions, usage), which the vendor reports on each model
// reply: claude and codex do. An agent with no reading yet shows nothing.

// usageOf is agent's readings, shortest window first (one whose length is
// unknown last), or undefined when there is none.
export function usageOf(agent: SavedAgent, subs: SubscriptionList | null | undefined): PlanReading[] | undefined {
  if (agent.access !== 'subscription' || !subs) return undefined;
  const usage = subs.subscriptions.find((s) => s.harness === agent.harness && s.connected)?.usage;
  if (!usage || usage.length === 0) return undefined;
  const len = (p: PlanReading) => p.window_minutes || Infinity;
  return [...usage].sort((a, b) => len(a) - len(b));
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

// shortLabel names a window in a few letters: "5h", "7d", "30m".
export function shortLabel(p: PlanReading): string {
  const m = p.window_minutes;
  if (!m) return p.window;
  if (m % (24 * 60) === 0) return `${m / (24 * 60)}d`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

// shortLine is the line under the bar, short enough for one line:
// "5h · 62% left · 14:20", the time being when it resets. The full words,
// "as of" included, are its tooltip (planLine).
export function shortLine(p: PlanReading, now: Date): string {
  const parts = [shortLabel(p), `${percentLeft(p)}% left`];
  if (p.resets_at && new Date(p.resets_at).getTime() > now.getTime()) parts.push(when(new Date(p.resets_at), now));
  return parts.join(' · ');
}

export const PlanUsage: React.FC<{ usage: PlanReading[] | undefined; now?: Date }> = ({ usage, now = new Date() }) => {
  if (!usage || usage.length === 0) return null;
  const shortest = usage[0];
  const longest = usage[usage.length - 1];
  const left = percentLeft(longest);
  const words = planLine(longest, now);
  return (
    <>
      <span className="quota" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-label={words} title={words}>
        <i style={{ width: `${left}%` }} />
      </span>
      {usage.length > 1 && <span className="q-l plan-line" title={planLine(shortest, now)}>{shortLine(shortest, now)}</span>}
    </>
  );
};
