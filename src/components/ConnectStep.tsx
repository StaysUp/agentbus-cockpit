import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectView, SubscriptionList } from '../types';

// The Connect step of a subscription agent: control adds the person's own
// subscription to the model calls of agents on their runners, which hold no
// sign-in. The person connects it once, here, with the harness's own login,
// run on control. One machine (agentbus up) needs none of this: its runner
// uses the harness's own sign-in.
//
// One layout for every harness, in four states: not connected, connecting
// (a button to the sign-in page, a one-time code to enter there, or a field
// for the code the page shows), connected, and failed. A link or a code is
// shown only while the login runs: control no longer returns them after.

export interface SubscriptionApi {
  list: () => Promise<SubscriptionList | null>;
  connect: (harness: string) => Promise<ConnectView>;
  get: (harness: string) => Promise<ConnectView>;
  input: (harness: string, line: string) => Promise<void>;
}

// pollMs is how often a running login is read again.
export const pollMs = 1000;

const day = (iso?: string) => (iso ? iso.slice(0, 10) : '');

export type ConnectPhase = 'not-connected' | 'connecting' | 'connected' | 'failed';

export const ConnectStep: React.FC<{ harness: string; api: SubscriptionApi }> = ({ harness, api }) => {
  const [list, setList] = useState<SubscriptionList | null | undefined>(undefined);
  const [listError, setListError] = useState<string | null>(null);
  // The connect started here, or one found running on open.
  const [view, setView] = useState<ConnectView | null>(null);
  // Why the last connect could not start or be read.
  const [failed, setFailed] = useState<string | null>(null);
  // The last connect here ended connected: shown so even before, or
  // without, a list that says so.
  const [connected, setConnected] = useState(false);
  const [code, setCode] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // The login took the code: nothing more is sent while it checks it.
  const [sent, setSent] = useState(false);
  const [starting, setStarting] = useState(false);
  // Refs as well as state: a second click in the same moment, before a
  // render, is ignored.
  const sendingRef = useRef(false);
  const startingRef = useRef(false);
  const alive = useRef(true);
  // Set on every mount: StrictMode mounts twice.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The list again; a login still running on control is followed, one that
  // ended before this was opened is not shown.
  const reload = useCallback(
    () =>
      api.list().then(
        (l) => {
          if (!alive.current) return;
          setList(l);
          setListError(null);
          const c = l?.subscriptions.find((s) => s.harness === harness)?.connect;
          if (c?.state === 'running') setView((v) => v ?? c);
        },
        (e: Error) => {
          if (alive.current) setListError(e.message);
        },
      ),
    [api, harness],
  );
  useEffect(() => {
    reload();
  }, [reload]);

  // A running login is read again until it ends; then the list says what is
  // kept. One read at a time: the next is asked for once the last answered.
  const running = view?.state === 'running';
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    let t: ReturnType<typeof setTimeout>;
    const poll = () => {
      t = setTimeout(() => {
        api.get(harness).then(
          (v) => {
            if (!alive.current || stopped) return;
            if (v.state === 'running') {
              setView(v);
              poll();
              return;
            }
            // Ended: it shows as connected or failed at once, and the list
            // read again says until when.
            setView(null);
            if (v.state === 'failed') setFailed(v.error || 'the login ended without connecting');
            else setConnected(true);
            reload();
          },
          // The login can no longer be read (control restarted, say): it
          // ended, so Connect can start another.
          (e: Error) => {
            if (!alive.current || stopped) return;
            setView(null);
            setFailed(e.message);
          },
        );
      }, pollMs);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(t);
    };
  }, [api, harness, running, reload]);

  if (list === undefined && listError) {
    return (
      <div className="connect-step" data-harness={harness}>
        <div className="form-error">{listError}</div>
      </div>
    );
  }
  if (list === undefined || list === null) return null; // not loaded, or a service that connects none
  const sub = list.subscriptions.find((s) => s.harness === harness);
  if (!sub) {
    return (
      <div className="connect-step" data-harness={harness}>
        <span className="nd-note">On a runner this subscription cannot be used yet; this agent runs where its harness is signed in.</span>
      </div>
    );
  }

  const phase: ConnectPhase =
    starting || running
      ? 'connecting'
      : failed !== null
        ? 'failed'
        : connected
          ? 'connected'
          : sub.expired
            ? 'failed'
            : sub.connected
              ? 'connected'
              : 'not-connected';
  const why = failed ?? (sub.expired ? sub.error || 'the sign-in expired' : '');
  const until = sub.renews ? 'renews automatically' : sub.expires_at ? `until ${day(sub.expires_at)}` : '';

  const connect = () => {
    if (startingRef.current || running) return;
    startingRef.current = true;
    setStarting(true);
    setFailed(null);
    setConnected(false);
    setView(null);
    setCode('');
    setSent(false);
    setSendError(null);
    api.connect(harness).then(
      (v) => {
        startingRef.current = false;
        if (!alive.current) return;
        setStarting(false);
        if (v.state === 'running') setView(v);
        else if (v.state === 'failed') setFailed(v.error || 'the login ended without connecting');
        else {
          setConnected(true);
          reload();
        }
      },
      (e: Error) => {
        startingRef.current = false;
        if (!alive.current) return;
        setStarting(false);
        setFailed(e.message);
      },
    );
  };

  // The code is kept until control took it, so a failed send can be sent
  // again. Once taken, the field stays closed until the login ends.
  const send = (e: React.SyntheticEvent) => {
    e.preventDefault();
    const line = code.trim();
    if (!line || sendingRef.current || sent) return;
    sendingRef.current = true;
    setSendError(null);
    setSending(true);
    api.input(harness, line).then(
      () => {
        sendingRef.current = false;
        if (!alive.current) return;
        setSending(false);
        setSent(true);
        setCode('');
      },
      (err: Error) => {
        sendingRef.current = false;
        if (!alive.current) return;
        setSending(false);
        setSendError(err.message);
      },
    );
  };

  // A sign-in that expired failed too, but no connect of this step did.
  const expired = phase === 'failed' && failed === null;
  const status = {
    'not-connected': 'not connected',
    connecting: 'connecting',
    connected: 'connected',
    failed: expired ? 'expired' : 'failed',
  }[phase];
  const label = {
    'not-connected': 'Connect',
    connecting: 'Connect',
    connected: 'Connect again',
    failed: expired ? 'Connect again' : 'Try again',
  }[phase];
  const link = running ? view?.output[0] : undefined;
  const oneTime = running ? view?.code : undefined;
  const paste = running && !!view?.paste;
  const closed = sending || sent;

  return (
    <div className="connect-step" data-harness={harness} data-phase={phase}>
      <div className="cs-head">
        <span>On your runners</span>
        <span className={`cs-status ${phase === 'connected' ? 'ok' : 'off'}`}>{status}</span>
        {phase === 'connected' && until && <span className="cs-until">{until}</span>}
        <button type="button" className="btn btn-secondary btn-sm cs-btn cs-connect" onClick={connect} disabled={phase === 'connecting'}>
          {label}
        </button>
      </div>
      {phase === 'failed' && <div className="form-error cs-why">{why}</div>}
      {phase === 'connecting' && (
        <div className="cs-login">
          {link ? (
            <a className="btn btn-primary btn-sm cs-btn cs-open" href={link} target="_blank" rel="noreferrer noopener">
              Open sign-in page
            </a>
          ) : (
            <span className="nd-note cs-wait">Waiting for the sign-in page.</span>
          )}
          {oneTime && (
            <div className="cs-step">
              <span>Enter this code on the sign-in page:</span>
              <strong className="cs-code">{oneTime}</strong>
              <span className="nd-note">This step ends by itself once you sign in.</span>
            </div>
          )}
          {link && paste && (
            // A nested form would submit the agent's form: this is a plain row.
            <div className="cs-step">
              <span>{sent ? 'Code sent. Checking it.' : 'Sign in, then paste the code the page shows.'}</span>
              <div className="cs-input">
                <input
                  type="text"
                  aria-label="Code from the sign-in page"
                  placeholder="code from the sign-in page"
                  value={code}
                  disabled={closed}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') send(e);
                  }}
                />
                <button type="button" className="btn btn-secondary btn-sm cs-btn" onClick={send} disabled={!code.trim() || closed}>
                  {sending ? 'Sending' : 'Send'}
                </button>
              </div>
              {sendError && <div className="form-error">{sendError}</div>}
            </div>
          )}
        </div>
      )}
      <span className="nd-note">
        Runners hold no sign-in. Control adds your subscription to their calls once you connect it here. The token
        stays on control and is never shown.
      </span>
      {listError && <div className="form-error">{listError}</div>}
    </div>
  );
};
