import React, { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { guideProgress, guideSteps, nextGuideStep, type GuideFacts, type GuideStep, type GuideStepId } from '../data/guide';
import { Button } from './Controls';
import { ColHead, PageFrame } from './PageFrame';
import { KEPT, PRODUCT } from '../words';

// What the guide can do from its steps. Each is the action the cockpit
// already has, passed in by App: the guide never repeats a form or a route.
export interface GuideActions {
  addAgent?: () => void;
  connect?: () => void;
  settings?: () => void;
  startSession?: () => void;
  cockpit?: () => void;
}

interface GuidePageProps {
  facts: GuideFacts;
  actions: GuideActions;
  onBack: () => void;
  // The foot nav targets, passed through to PageFrame. The Guide row is left
  // out here (this is that page).
  onApps?: () => void;
  onRunners?: () => void;
  onSettings?: () => void;
  runnersOnline?: number;
  version?: string;
  sourceLabel?: string;
  streamUp?: boolean;
  onDisconnect?: () => void;
  disconnectLabel?: string;
}

// The setup guide (/guide): the README quickstart as a checklist. The left
// column is the steps, the middle is the one picked, and the right is what the
// cockpit read: the agents, the sign-ins and the sessions. A step is done from
// those facts, never from a saved click, so the guide always tells the truth
// about this data folder.
export const GuidePage: React.FC<GuidePageProps> = ({
  facts,
  actions,
  onBack,
  onApps,
  onRunners,
  onSettings,
  runnersOnline,
  version,
  sourceLabel,
  streamUp,
  onDisconnect,
  disconnectLabel,
}) => {
  const steps = useMemo(() => guideSteps(facts), [facts]);
  const progress = guideProgress(steps);
  const next = nextGuideStep(steps);
  const [picked, setPicked] = useState<GuideStepId>(() => next?.id ?? steps[0]?.id ?? 'running');
  const step = steps.find((s) => s.id === picked) ?? steps[0];
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <PageFrame
      title="Setup"
      current="guide"
      onBack={onBack}
      onApps={onApps}
      onRunners={onRunners}
      onSettings={onSettings}
      runnersOnline={runnersOnline}
      version={version}
      sourceLabel={sourceLabel}
      streamUp={streamUp}
      onDisconnect={onDisconnect}
      disconnectLabel={disconnectLabel}
      list={
        <>
          <div className="gd-sum">
            <div className="gd-sumline">
              <b>{progress.done}</b>{' '}
              <span>of {progress.total} steps done</span>
            </div>
            <div
              className="gd-bar"
              role="progressbar"
              aria-label="Setup progress"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
            >
              <span style={{ width: `${pct}%` }} />
            </div>
          </div>
          <nav className="gd-steps" aria-label="Setup steps">
            {steps.map((s) => {
              const on = s.id === step.id;
              return (
                <button
                  type="button"
                  key={s.id}
                  className={`prow pick gd-row${on ? ' on' : ''}`}
                  aria-current={on ? 'step' : undefined}
                  data-step={s.id}
                  data-done={s.done ? 'yes' : 'no'}
                  onClick={() => setPicked(s.id)}
                >
                  <span className="pr-n">
                    <span className={`gd-n${s.done ? ' done' : ''}`}>
                      {s.done ? <Check size={14} strokeWidth={2.8} aria-hidden="true" /> : s.n}
                    </span>
                    <span className="gd-t">{s.title}</span>
                    {s.optional && <span className="gd-opt">Optional</span>}
                  </span>
                  <span className="pl-n">{s.line}</span>
                </button>
              );
            })}
          </nav>
        </>
      }
      main={
        <>
          <ColHead title={step.title} sub={step.optional ? 'optional' : `step ${step.n} of ${steps.length}`} />
          <div className="colbody pg-body">
            {stepBody(step, { sourceLabel, version })}
            <div className="gd-actions">{stepAction(step, actions)}</div>
          </div>
        </>
      }
      side={
        <>
          <ColHead title="At a glance" />
          <div className="colbody pg-body">
            <div className="gd-score">
              <b>{progress.done}</b>{' '}
              <span>of {progress.total} done</span>
            </div>
            <div className="gd-bar">
              <span style={{ width: `${pct}%` }} />
            </div>
            <table className="grid pg-kv gd-facts">
              <tbody>
                <tr>
                  <td>Agents</td>
                  <td>{facts.agents}</td>
                </tr>
                <tr>
                  <td>Sign-in</td>
                  <td>{facts.signIn ? 'ready' : 'not yet'}</td>
                </tr>
                <tr>
                  <td>Sessions</td>
                  <td>{facts.sessions}</td>
                </tr>
                <tr>
                  <td>Two agents</td>
                  <td>{facts.workedTogether > 0 ? 'yes' : 'not yet'}</td>
                </tr>
                {version && (
                  <tr>
                    <td>Build</td>
                    <td>{version}</td>
                  </tr>
                )}
                {sourceLabel && (
                  <tr>
                    <td>Address</td>
                    <td className="gd-addr">
                      <code>{sourceLabel}</code>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="sub-h">Next</div>
            {next ? (
              <p className="pg-note">
                <b>{next.title}</b>
                {next.optional ? ' (optional)' : ''}
                <br />
                {next.line}
              </p>
            ) : (
              <p className="pg-note">You are set up. Open the cockpit and start a session.</p>
            )}
          </div>
        </>
      }
    />
  );
};

// The middle column's copy for one step. The left column's line says the same
// thing in a few words; this says what to do and what the cockpit will show.
function stepBody(step: GuideStep, facts: { sourceLabel?: string; version?: string }): React.ReactNode {
  switch (step.id) {
    case 'running':
      return (
        <>
          <p className="pg-note">
            This cockpit and the API are served by the same {PRODUCT} process. Your sessions, model calls and keys
            stay on this machine.
          </p>
          <pre className="term gd-term">$ agentbus up -open</pre>
          <p className="gd-note">
            {facts.sourceLabel ? (
              <>
                Connected to <code>{facts.sourceLabel}</code>
                {facts.version ? ` · build ${facts.version}` : ''}.
              </>
            ) : (
              'Connected.'
            )}
          </p>
        </>
      );
    case 'agents':
      return (
        <>
          <p className="pg-note">
            An agent is a saved setup: a harness, how it reaches a model, and a model. Add one or more. The
            quickstart uses Claude Code and Codex, so each can ask the other for a second opinion.
          </p>
          <table className="grid pg-kv gd-facts">
            <tbody>
              <tr>
                <td>Harnesses</td>
                <td>Claude Code · Codex · Antigravity · OpenCode</td>
              </tr>
              <tr>
                <td>Access</td>
                <td>a subscription connected in Settings, or a key</td>
              </tr>
            </tbody>
          </table>
        </>
      );
    case 'sign-in':
      return (
        <>
          <p className="pg-note">
            {PRODUCT} uses the sign-ins you connect in Settings, not the CLI&rsquo;s own on this machine. Connect
            each subscription once, or set an OpenRouter or vendor key.
          </p>
          <p className="gd-note">{KEPT}</p>
        </>
      );
    case 'config':
      return (
        <p className="pg-note">
          Optional. In Settings, open Config and press <b>Use my config</b> to bring your settings, skills, MCP
          servers and logins such as <code>gh</code> and <code>aws</code> into every session.
        </p>
      );
    case 'session':
      return (
        <>
          <p className="pg-note">
            Pick a machine and a folder, then send the first message. The agent works in its own copy of the
            folder; nothing in your folder changes until you apply the turn.
          </p>
          <p className="gd-note">A session starts with its first message.</p>
        </>
      );
    case 'second-agent':
      return (
        <>
          <p className="pg-note">
            In a session, pick another agent beside Send and ask it to check the work. Its reply comes back as
            the next turn, and every model call stays in the record.
          </p>
          <p className="gd-note">A different vendor gives the best second opinion.</p>
        </>
      );
  }
}

// The middle column's one action, when the cockpit can take it.
function stepAction(step: GuideStep, actions: GuideActions): React.ReactNode {
  switch (step.id) {
    case 'agents':
      return actions.addAgent ? (
        <Button kind="primary" onClick={actions.addAgent}>
          Add agent
        </Button>
      ) : (
        <p className="gd-note">This service keeps no saved agents.</p>
      );
    case 'sign-in':
      return actions.connect ? (
        <Button kind="primary" onClick={actions.connect}>
          Open Settings
        </Button>
      ) : (
        <p className="gd-note">This service keeps no subscriptions.</p>
      );
    case 'config':
      return actions.settings ? (
        <Button kind="secondary" onClick={actions.settings}>
          Open Settings
        </Button>
      ) : null;
    case 'session':
      return actions.startSession ? (
        <Button kind="primary" onClick={actions.startSession}>
          Start a session
        </Button>
      ) : (
        <>
          <p className="gd-note">Add an agent first.</p>
          {actions.addAgent && (
            <Button kind="secondary" onClick={actions.addAgent}>
              Add agent
            </Button>
          )}
        </>
      );
    case 'second-agent':
    case 'running':
      return actions.cockpit ? (
        <Button kind="secondary" onClick={actions.cockpit}>
          Open the cockpit
        </Button>
      ) : null;
  }
}
