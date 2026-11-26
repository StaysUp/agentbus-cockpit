// The setup guide's facts and steps. The content follows the AgentBus
// quickstart, and every step that the cockpit can see is marked done from
// what it already reads: the saved agents, the subscriptions and the sessions.
// Nothing new is stored for the guide, so it cannot fall out of step with the
// cockpit (SOLID: one source of truth; DRY: the facts are read once).
import type { SavedAgent, SessionSummary, SubscriptionList } from '../types';

export type GuideStepId = 'running' | 'agents' | 'sign-in' | 'config' | 'session' | 'second-agent';

export interface GuideFacts {
  // The cockpit reached the service: this is the page agentbus up serves.
  connected: boolean;
  // The saved agents the person has made.
  agents: number;
  // A subscription is connected, or a key is set for an agent. This is the
  // one question Settings answers; the guide only needs yes or no.
  signIn: boolean;
  // The person's own sessions, not the ones an agent asked for.
  sessions: number;
  // Sessions that two agents have taken part in: the first turn's agent and
  // the latest turn's differ.
  workedTogether: number;
}

export interface GuideStep {
  id: GuideStepId;
  // The step's number in the quickstart. An optional step keeps its number.
  n: number;
  title: string;
  line: string;
  done: boolean;
  optional?: boolean;
}

// guideSteps is the quickstart in the cockpit's words. The optional steps are
// the two the person may take in any order: bringing their config, and asking
// a second agent for a second opinion.
export function guideSteps(f: GuideFacts): GuideStep[] {
  return [
    {
      id: 'running',
      n: 1,
      title: 'AgentBus is running',
      line: 'The cockpit and the API are the same process.',
      done: f.connected,
    },
    {
      id: 'agents',
      n: 2,
      title: 'Add your agents',
      line: 'Claude Code, Codex, Antigravity or OpenCode.',
      done: f.agents > 0,
    },
    {
      id: 'sign-in',
      n: 3,
      title: 'Connect a sign-in',
      line: 'A subscription or a key, set in Settings.',
      done: f.signIn,
    },
    {
      id: 'config',
      n: 4,
      title: 'Bring your setup',
      line: 'Your settings, skills and MCP servers, in every session.',
      done: false,
      optional: true,
    },
    {
      id: 'session',
      n: 5,
      title: 'Start a session',
      line: 'Pick a folder and send the first message.',
      done: f.sessions > 0,
    },
    {
      id: 'second-agent',
      n: 6,
      title: 'Ask a second agent',
      line: 'Another agent checks the work in the same session.',
      done: f.workedTogether > 0,
      optional: true,
    },
  ];
}

// guideProgress counts the steps that are part of setup. The two optional
// steps are left out, so a person with one agent still reaches the end.
export function guideProgress(steps: GuideStep[]): { done: number; total: number } {
  const required = steps.filter((s) => !s.optional);
  return { done: required.filter((s) => s.done).length, total: required.length };
}

// nextGuideStep is the step to open first: the earliest one still to do, and
// after the required steps are done, the first optional one that is left.
export function nextGuideStep(steps: GuideStep[]): GuideStep | undefined {
  return steps.find((s) => !s.done && !s.optional) ?? steps.find((s) => !s.done);
}

// signInReady says Settings has something a turn can use: a subscription
// connected, a key set, or an environment variable a saved OpenRouter agent
// names. It does not ask which agent uses it; the guide's step is "set one
// up", and the Agents column's dots say which agent can use it.
export function signInReady(subs: SubscriptionList | null | undefined): boolean {
  if (!subs) return false;
  if (subs.subscriptions.some((s) => s.connected && !s.expired)) return true;
  if (Object.values(subs.api_keys ?? {}).some((k) => k.set)) return true;
  return Object.values(subs.env_keys ?? {}).some(Boolean);
}

// guideFacts builds the guide's facts from the cockpit's own reads.
export function guideFacts(input: {
  connected: boolean;
  agents?: SavedAgent[];
  subscriptions?: SubscriptionList | null;
  sessions: SessionSummary[];
}): GuideFacts {
  return {
    connected: input.connected,
    agents: input.agents?.length ?? 0,
    signIn: signInReady(input.subscriptions),
    sessions: input.sessions.length,
    workedTogether: input.sessions.filter((s) => !!s.first_agent && !!s.agent && s.first_agent !== s.agent).length,
  };
}
