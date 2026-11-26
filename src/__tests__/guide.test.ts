import { describe, expect, it } from 'vitest';
import { guideFacts, guideProgress, guideSteps, nextGuideStep, signInReady, type GuideFacts } from '../data/guide';
import type { SavedAgent, SessionSummary, SubscriptionList } from '../types';

const facts = (over: Partial<GuideFacts> = {}): GuideFacts => ({
  connected: true,
  agents: 2,
  signIn: true,
  sessions: 1,
  workedTogether: 1,
  ...over,
});

const agent = (id: string): SavedAgent => ({ id, name: id, harness: 'claude', access: 'subscription' });
const session = (id: string, first?: string, latest?: string): SessionSummary =>
  ({
    id,
    agent: latest ?? 'claude',
    first_agent: first,
    client: '',
    title: id,
    started: '',
    last: '',
    open: false,
    turns: 1,
    usage: { input_tokens: 0, output_tokens: 0 },
  }) as SessionSummary;
const subscriptions = (over: Partial<SubscriptionList> = {}): SubscriptionList => ({
  subscriptions: [],
  ...over,
});

describe('the setup guide steps', () => {
  it('follows the quickstart, with the two optional steps marked', () => {
    const steps = guideSteps(facts());
    expect(steps.map((s) => s.id)).toEqual(['running', 'agents', 'sign-in', 'config', 'session', 'second-agent']);
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(steps.filter((s) => s.optional).map((s) => s.id)).toEqual(['config', 'second-agent']);
  });

  it('counts only the required steps, and opens the first one left to do', () => {
    const fresh = guideSteps(facts({ agents: 0, signIn: false, sessions: 0, workedTogether: 0 }));
    expect(guideProgress(fresh)).toEqual({ done: 1, total: 4 });
    expect(nextGuideStep(fresh)?.id).toBe('agents');

    const ready = guideSteps(facts({ agents: 1, signIn: true, sessions: 1, workedTogether: 0 }));
    expect(guideProgress(ready)).toEqual({ done: 4, total: 4 });
    // The optional steps are the next thing to try, in their own order.
    expect(nextGuideStep(ready)?.id).toBe('config');
  });

  it('marks a step done from what the cockpit saw, not from a click', () => {
    const one = guideSteps(facts({ agents: 1, signIn: false, sessions: 0, workedTogether: 0 }));
    expect(one.find((s) => s.id === 'agents')?.done).toBe(true);
    expect(one.find((s) => s.id === 'sign-in')?.done).toBe(false);
    expect(one.find((s) => s.id === 'session')?.done).toBe(false);
  });
});

describe('the guide facts', () => {
  it('reads a connected subscription, a stored key or an environment key', () => {
    expect(signInReady(null)).toBe(false);
    expect(signInReady(subscriptions())).toBe(false);
    expect(
      signInReady(
        subscriptions({
          subscriptions: [{ harness: 'claude', connected: true, expired: false }],
        })
      )
    ).toBe(true);
    expect(signInReady(subscriptions({ api_keys: { openrouter: { set: true } } }))).toBe(true);
    expect(signInReady(subscriptions({ env_keys: { OPENROUTER_API_KEY: true } }))).toBe(true);
  });

  it('counts the person’s sessions and the ones two agents took part in', () => {
    const f = guideFacts({
      connected: true,
      agents: [agent('a_1'), agent('a_2')],
      subscriptions: subscriptions({ api_keys: { xai: { set: true } } }),
      sessions: [session('s1', 'claude', 'claude'), session('s2', 'claude', 'codex'), session('s3')],
    });
    expect(f).toEqual({ connected: true, agents: 2, signIn: true, sessions: 3, workedTogether: 1 });
  });
});
