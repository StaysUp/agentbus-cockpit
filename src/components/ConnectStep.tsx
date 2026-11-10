import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectView, SubscriptionList } from '../types';

// The Connect step of a subscription agent: control adds the person's own
// subscription to the model calls of agents on their runners, which hold no
// sign-in. The person connects it once, here, with the harness's own login,
// run on control: of what it prints, only the links come back, where to sign
// in, and the code the browser then shows is typed here. One
// machine (agentbus up) needs none of this: its runner uses the harness's own
// sign-in.

export interface SubscriptionApi {
  list: () => Promise<SubscriptionList | null>;
  connect: (harness: string) => Promise<ConnectView>;
  get: (harness: string) => Promise<ConnectView>;
  input: (harness: string, line: string) => Promise<void>;
  turnOn: () => Promise<void>;
}

// pollMs is how often a running login's output is read again.
export const pollMs = 1000;

const day = (iso?: string) => (iso ? iso.slice(0, 10) : '');

// A line with links: each http(s) URL the login prints is where to sign in.
const Line: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(https?:\/\/\S+)/g);
  return (
    <div className="cs-line">
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer noopener">
            {p}
          </a>
        ) : (
          <React.Fragment key={i}>{p}</React.Fragment>
        ),
      )}
    </div>
  );
};

export const ConnectStep: React.FC<{ harness: string; api: SubscriptionApi }> = ({ harness, api }) => {
  const [list, setList] = useState<SubscriptionList | null | undefined>(undefined);
  const [view, setView] = useState<ConnectView | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [turningOn, setTurningOn] = useState(false);
  const [sending, setSending] = useState(false);
  const [connecting, setConnecting] = useState(false);
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
          const c = l?.subscriptions.find((s) => s.harness === harness)?.connect;
          if (c?.state === 'running') setView((v) => v ?? c);
        },
        (e: Error) => {
          if (alive.current) setError(e.message);
        },
      ),
    [api, harness],
  );
  useEffect(() => {
    reload();
  }, [reload]);

  // A running login is read again until it ends; then the list says what is
  // kept.
  const running = view?.state === 'running';
  // One read at a time: the next is asked for only once the last answered.
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    let t: ReturnType<typeof setTimeout>;
    const poll = () => {
      t = setTimeout(() => {
        api.get(harness).then(
          (v) => {
            if (!alive.current || stopped) return;
            setView(v);
            if (v.state !== 'running') reload();
            else poll();
          },
          // The login can no longer be read (control restarted, say): it is
          // shown as ended, so Connect can start another.
          (e: Error) => {
            if (!alive.current || stopped) return;
            setView((v) => (v ? { ...v, state: 'failed', error: e.message } : v));
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

  if (list === undefined && error) {
    return (
      <div className="connect-step" data-harness={harness}>
        <div className="form-error">{error}</div>
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
  const until = sub.expires_at ? `, until ${day(sub.expires_at)}` : '';
  const status = sub.expired
    ? 'expired: connect again'
    : sub.connected
      ? `connected${until}`
      : 'not connected';
  const connect = () => {
    if (connecting) return;
    setError(null);
    setView(null);
    setCode('');
    setConnecting(true);
    api.connect(harness).then(
      (v) => {
        if (!alive.current) return;
        setConnecting(false);
        setView(v);
      },
      (e: Error) => {
        if (!alive.current) return;
        setConnecting(false);
        setError(e.message);
      },
    );
  };
  // The code is kept until control took it, so a failed send can be sent
  // again.
  const send = (e: React.SyntheticEvent) => {
    e.preventDefault();
    const line = code.trim();
    if (!line || sending) return;
    setError(null);
    setSending(true);
    api.input(harness, line).then(
      () => {
        if (!alive.current) return;
        setSending(false);
        setCode('');
      },
      (err: Error) => {
        if (!alive.current) return;
        setSending(false);
        setError(err.message);
      },
    );
  };
  return (
    <div className="connect-step" data-harness={harness}>
      <div className="cs-head">
        <span>On your runners</span>
        <span className={`cs-status ${sub.connected && !sub.expired ? 'ok' : 'off'}`}>{status}</span>
        {!running && (
          <button type="button" className="cs-connect" onClick={connect} disabled={connecting}>
            {sub.connected ? 'Connect again' : 'Connect'}
          </button>
        )}
      </div>
      <span className="nd-note">
        Runners hold no sign-in. Control adds your own subscription to their calls once you connect it here, with the
        harness's own login. The token stays on control and is never shown.
        {!list.on && ' It is off until subscriptions_on_runners is "own".'}
      </span>
      {!list.on && (
        <button
          type="button"
          className="cs-on"
          disabled={turningOn}
          onClick={() => {
            setError(null);
            setTurningOn(true);
            // Held until the list says it is on, so it is never sent twice.
            api.turnOn().then(
              () => reload().then(() => alive.current && setTurningOn(false)),
              (e: Error) => {
                if (!alive.current) return;
                setTurningOn(false);
                setError(e.message);
              },
            );
          }}
        >
          Turn on for my runners
        </button>
      )}
      {view && (
        <div className="cs-login" aria-label="Login output">
          {(view.output ?? []).map((l, i) => (
            <Line key={i} text={l} />
          ))}
          {view.state === 'failed' && <div className="form-error">{view.error}</div>}
          {view.state === 'connected' && <div className="cs-done">Connected.</div>}
        </div>
      )}
      {running && <span className="nd-note">Sign in at the link, then type the code the browser shows.</span>}
      {running && (
        // A nested form would submit the agent's form: this is a plain row.
        <div className="cs-input">
          <input
            aria-label="Code from the browser"
            placeholder="code from the browser"
            value={code}
            disabled={sending}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send(e);
            }}
          />
          <button type="button" onClick={send} disabled={!code.trim() || sending}>
            Send
          </button>
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
    </div>
  );
};
