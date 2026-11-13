import React from 'react';
import { SavedAgent, SubscriptionList } from '../types';

// A saved agent's sign-in, as one dot: green when its tool is connected,
// yellow when it is not or its sign-in expired. It is read from what the
// cockpit already has: the subscriptions control keeps (GET
// /api/v0/subscriptions) and the agent's own key_set. Nothing is blocked by
// it; a turn whose tool is not connected is refused when it starts.
export interface SignIn {
  ok: boolean;
  title: string;
}

// signInOf is the dot for agent, or undefined when nothing says: a
// subscription agent before the subscriptions are read, or on a service
// that keeps none, and an agent of any other access.
// The key an agent on access "api" uses, by its harness.
const apiKeyLabel: Record<string, string> = { claude: 'Anthropic API key', codex: 'OpenAI API key', agy: 'Gemini API key' };

export function signInOf(agent: SavedAgent, subs: SubscriptionList | null | undefined): SignIn | undefined {
  if (agent.access === 'subscription') {
    if (!subs) return undefined;
    const s = subs.subscriptions.find((x) => x.harness === agent.harness);
    const h = agent.harness;
    if (s?.expired) return { ok: false, title: `${h}'s sign-in expired — open Settings to connect again` };
    if (s?.connected) return { ok: true, title: `${h} is connected` };
    return { ok: false, title: `${h} is not connected — open Settings to connect` };
  }
  if (agent.access === 'openrouter') {
    // A key set in Settings, or the agent's own environment variable.
    const inSettings = subs?.openrouter_key?.set;
    if (inSettings || agent.key_set) return { ok: true, title: 'OpenRouter key is set' };
    if (!subs && agent.key_set === undefined) return undefined;
    return { ok: false, title: 'OpenRouter key is not set — open Settings to add it' };
  }
  if (agent.access === 'api') {
    // The vendor's API key set in Settings, as control says on the agent.
    if (agent.key_set === undefined) return undefined;
    const key = apiKeyLabel[agent.harness] ?? `${agent.harness}'s API key`;
    return agent.key_set ? { ok: true, title: `${key} is set` } : { ok: false, title: `${key} is not set — open Settings to add it` };
  }
  return undefined;
}

// SignInDot is the dot itself, in the Runners page's dot style. With onOpen
// a click opens Settings → Subscriptions, the one place to connect. It is a
// span with a button's role, as it sits inside an agent row that is itself a
// button.
export const SignInDot: React.FC<{ signIn: SignIn | undefined; onOpen?: () => void }> = ({ signIn, onOpen }) => {
  if (!signIn) return null;
  const cls = `rn-dot signin-dot${signIn.ok ? '' : ' pending'}${onOpen ? ' opens' : ''}`;
  if (!onOpen) return <span className={cls} data-signin={signIn.ok ? 'ok' : 'no'} title={signIn.title} aria-label={signIn.title} role="img" />;
  const open = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onOpen();
  };
  return (
    <span
      className={cls}
      data-signin={signIn.ok ? 'ok' : 'no'}
      title={signIn.title}
      aria-label={signIn.title}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') open(e);
      }}
    />
  );
};
