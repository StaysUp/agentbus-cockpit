import React, { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { ConnectView, SubscriptionList } from '../types';
import { harnessName, PRODUCT } from '../words';
import { Button, buttonClass } from './Controls';
import { Notice } from './Notice';

// The Connect step of a subscription, in an agent's form and in Settings:
// AgentBus adds the person's own subscription to the model calls of every
// turn, on one machine (agentbus up) as on every runner; none of them uses a
// sign-in of its own. The person connects it once, here, with the harness's
// own login, run by AgentBus.
//
// One layout for every harness, in four states: not connected, connecting
// (a button to the sign-in page, a one-time code to enter there, or a field
// for the code the page shows, and Cancel), connected, and failed. A code
// the login did not take fails at once, as rejected. A link or a code is
// shown only while the login runs: control no longer returns them after.

export interface SubscriptionApi {
  list: () => Promise<SubscriptionList | null>;
  connect: (harness: string) => Promise<ConnectView>;
  get: (harness: string) => Promise<ConnectView>;
  input: (harness: string, line: string) => Promise<void>;
  // Stops the running login. Absent: a service without it, and no Cancel.
  cancel?: (harness: string) => Promise<void>;
  // Set and remove the OpenRouter key kept on control. Absent: a service
  // without them, and no OpenRouter key row.
  setKey?: (key: string) => Promise<void>;
  removeKey?: () => Promise<void>;
  // Set and remove a vendor's API key kept on control, by its name
  // (anthropic, openai, gemini). Absent: no API key rows.
  setAPIKey?: (name: string, key: string) => Promise<void>;
  removeAPIKey?: (name: string) => Promise<void>;
}

// pollMs is how often a running login is read again.
export const pollMs = 1000;

const day = (iso?: string) => (iso ? iso.slice(0, 10) : '');

// The words of a login that ended without saying why.
const ENDED = 'The sign-in ended without connecting.';

// The head of a sign-in or key card: its name and state on the left, its
// actions on the right, on one row. The state is coloured only by status.
export const CardHead: React.FC<{ name: string; ok: boolean; state: string; detail?: string; children?: React.ReactNode }> = ({
  name,
  ok,
  state,
  detail,
  children,
}) => (
  <div className="cs-head">
    <span className="cs-name">
      <b>{name}</b>
      <span className={`cs-status ${ok ? 'ok' : 'warn'}`}>{state}</span>
      {detail && <span className="cs-until">{detail}</span>}
    </span>
    <span className="cs-acts">{children}</span>
  </div>
);

export type ConnectPhase = 'not-connected' | 'connecting' | 'connected' | 'failed';

export interface ConnectStepHandle {
  leave: () => void;
}

export const ConnectStep: React.FC<{
  ref?: React.Ref<ConnectStepHandle>;
  harness: string;
  api: SubscriptionApi;
  onSigningInChange?: (active: boolean) => void;
}> = ({ ref, harness, api, onSigningInChange }) => {
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
  // The last connect failed because the login did not take the code.
  const [rejected, setRejected] = useState(false);
  // Cancel was clicked for the login on screen: the button stays held
  // until that login ends, or until the cancel request itself fails.
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [signInRequested, setSignInRequested] = useState(false);
  const [copyState, setCopyState] = useState<'copied' | 'failed' | null>(null);
  const signInHint = useId();
  const step = useRef<HTMLDivElement>(null);
  const signInStatus = useRef<HTMLSpanElement>(null);
  const deviceCode = useRef<HTMLSpanElement>(null);
  // Refs as well as state: a second click in the same moment, before a
  // render, is ignored.
  const sendingRef = useRef(false);
  const startingRef = useRef(false);
  const cancellingRef = useRef(false);
  const cancelRequest = useRef<Promise<void> | null>(null);
  const openingRef = useRef<Promise<boolean> | null>(null);
  // One rule for every answer: it belongs to its own login. Each login
  // started here gets the next id; every request (connect, read, code,
  // cancel) keeps the id it was sent for, and its answer is applied only
  // while that login is still the current one. Any other answer is ignored.
  const loginRef = useRef(0);
  const alive = useRef(true);
  const current = (id: number) => alive.current && id === loginRef.current;
  // A login starts or ends: nothing of the last one is held.
  const fresh = () => {
    sendingRef.current = false;
    cancellingRef.current = false;
    openingRef.current = null;
    setSending(false);
    setSent(false);
    setSendError(null);
    setCode('');
    setCancelling(false);
    setCancelError(null);
    setChecking(false);
    setSignInRequested(false);
    setCopyState(null);
  };
  // Set on every mount: StrictMode mounts twice.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The list again; a login still running on control is followed, one that
  // ended before this was opened is not shown.
  const reload = useCallback(() => {
    const id = loginRef.current;
    return api.list().then(
      (l) => {
        if (!alive.current) return;
        setList(l);
        setListError(null);
        // Only for the login it was asked for: not over one started since.
        const c = l?.subscriptions.find((s) => s.harness === harness)?.connect;
        if (c?.state === 'running' && id === loginRef.current) setView((v) => v ?? c);
      },
      (e: Error) => {
        if (alive.current) setListError(e.message);
      },
    );
  }, [api, harness]);
  useEffect(() => {
    reload();
  }, [reload]);

  // A running login is read again until it ends; then the list says what is
  // kept. One read at a time: the next is asked for once the last answered.
  const running = view?.state === 'running';
  const signingIn = starting || running;
  const dedicated = !!onSigningInChange && signingIn;
  const providerPage = running ? view?.output[0] : undefined;
  const link = providerPage && /^https?:\/\//i.test(providerPage) ? providerPage : undefined;
  const canReturnToSetup = starting || !api.cancel || cancelling || cancelError !== null;

  // The status poll confirms whether control cancelled the login. Keep the
  // form recoverable while the request is pending or if control refuses it.
  const cancel = () => {
    if (!api.cancel || cancellingRef.current) return;
    const id = loginRef.current;
    cancellingRef.current = true;
    openingRef.current = null;
    setCancelling(true);
    const request = api.cancel(harness);
    cancelRequest.current = request;
    request.catch((err: Error) => {
      if (!current(id)) return;
      cancellingRef.current = false;
      setCancelling(false);
      if (dedicated) setCancelError(err.message);
    }).finally(() => {
      if (cancelRequest.current === request) cancelRequest.current = null;
    });
  };
  const leave = () => {
    if (!dedicated) return;
    if (!canReturnToSetup) {
      cancel();
      return;
    }
    // Stop following this attempt locally. Its late answers must not take
    // over the restored form or a later attempt.
    ++loginRef.current;
    startingRef.current = false;
    setStarting(false);
    setView(null);
    fresh();
  };
  useImperativeHandle(ref, () => ({ leave }));
  useLayoutEffect(() => {
    onSigningInChange?.(signingIn);
  }, [onSigningInChange, signingIn]);
  useEffect(() => {
    if (dedicated) signInStatus.current?.focus();
    else if (onSigningInChange && loginRef.current > 0) {
      step.current?.querySelector<HTMLButtonElement>('.cs-connect')?.focus();
    }
  }, [dedicated, onSigningInChange]);
  useEffect(() => {
    if (!running) return;
    // stopped ends this loop of reads when the effect is cleaned up.
    let stopped = false;
    let t: ReturnType<typeof setTimeout>;
    let reading: 'poll' | 'return' | null = null;
    let recheckOnReturn = false;
    const id = loginRef.current;
    const end = () => {
      recheckOnReturn = false;
      ++loginRef.current;
      setView(null);
      fresh();
    };
    const read = (reason: 'poll' | 'return' = 'poll') => {
      if (stopped || reading || !current(id)) return;
      clearTimeout(t);
      reading = reason;
      api.get(harness).then(
        (v) => {
          if (stopped || !current(id)) return;
          if (v.state === 'running') {
            setView(v);
            t = setTimeout(read, pollMs);
            return;
          }
          // Ended: the status appears immediately, and the list says until
          // when. A cancelled login restores its prior status.
          end();
          if (v.state === 'failed' && !v.cancelled) {
            setFailed(v.error || ENDED);
            setRejected(!!v.rejected);
          } else if (v.state !== 'failed') setConnected(true);
          reload();
        },
        (e: Error) => {
          if (stopped || !current(id)) return;
          end();
          setFailed(e.message);
        },
      ).finally(() => {
        reading = null;
        if (stopped || !current(id)) return;
        if (recheckOnReturn) {
          recheckOnReturn = false;
          read('return');
        } else setChecking(false);
      });
    };
    const checkOnReturn = () => {
      if (document.visibilityState === 'hidden' || !current(id)) return;
      setChecking(true);
      // A background poll can return a status from before the user came back.
      if (reading === 'poll') recheckOnReturn = true;
      else read('return');
    };
    t = setTimeout(read, pollMs);
    if (dedicated) {
      window.addEventListener('focus', checkOnReturn);
      document.addEventListener('visibilitychange', checkOnReturn);
    }
    return () => {
      stopped = true;
      clearTimeout(t);
      window.removeEventListener('focus', checkOnReturn);
      document.removeEventListener('visibilitychange', checkOnReturn);
    };
  }, [api, dedicated, harness, running, reload]);

  if (list === undefined && listError) {
    return (
      <div className="connect-step" data-harness={harness}>
        <Notice kind="error">{listError}</Notice>
      </div>
    );
  }
  if (list === undefined || list === null) return null; // not loaded, or a service that connects none
  const sub = list.subscriptions.find((s) => s.harness === harness);
  if (!sub) {
    return (
      <div className="connect-step" data-harness={harness}>
        <span className="nd-note">{PRODUCT} cannot connect this sign-in.</span>
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
  const why = failed ?? (sub.expired ? sub.error || 'The sign-in expired.' : '');
  const until = sub.renews ? 'renews automatically' : sub.expires_at ? `until ${day(sub.expires_at)}` : '';

  const connect = () => {
    if (startingRef.current || running) return;
    const id = ++loginRef.current;
    startingRef.current = true;
    setStarting(true);
    setFailed(null);
    setRejected(false);
    setConnected(false);
    setView(null);
    fresh();
    const begin = () => current(id) ? api.connect(harness) : undefined;
    // A previous Cancel must finish before another login starts on control.
    const request = cancelRequest.current;
    (request ? request.then(begin, begin) : Promise.resolve(begin())).then(
      (v) => {
        if (!v || !current(id)) return;
        startingRef.current = false;
        setStarting(false);
        if (v.state === 'running') setView(v);
        else {
          if (v.state === 'failed') setFailed(v.error || ENDED);
          else {
            setConnected(true);
            reload();
          }
        }
      },
      (e: Error) => {
        if (!current(id)) return;
        startingRef.current = false;
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
    const id = loginRef.current;
    sendingRef.current = true;
    setSendError(null);
    setSending(true);
    api.input(harness, line).then(
      () => {
        if (!current(id)) return;
        sendingRef.current = false;
        setSending(false);
        setSent(true);
        setCode('');
      },
      (err: Error) => {
        if (!current(id)) return;
        sendingRef.current = false;
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
    failed: expired ? 'expired' : rejected ? 'code rejected' : 'failed',
  }[phase];
  const label = {
    'not-connected': 'Connect',
    connecting: 'Connect',
    connected: 'Connect again',
    failed: expired ? 'Connect again' : 'Try again',
  }[phase];
  const oneTime = running ? view?.code : undefined;
  const paste = running && !!view?.paste;
  const closed = sending || sent;
  const verifying = checking || sent;
  const waitingForBrowser = signInRequested && !paste;
  const signInMessage = cancelling
    ? 'Cancelling sign-in…'
    : verifying
      ? 'Checking connection…'
      : waitingForBrowser
        ? 'Waiting for sign-in in the other tab…'
        : signInRequested
          ? 'Waiting for the sign-in code'
          : link
            ? 'Ready to sign in'
            : 'Preparing sign-in…';
  const actions = phase === 'connecting' && api.cancel ? (
    <Button kind="secondary" small className="cs-cancel" onClick={cancel} disabled={cancelling || starting}>
      {cancelling ? 'Cancelling…' : 'Cancel'}
    </Button>
  ) : (
    <Button kind="secondary" small className="cs-connect" onClick={connect} disabled={phase === 'connecting'}>
      {label}
    </Button>
  );

  const canCopy = typeof navigator.clipboard?.writeText === 'function';
  const copyBeforeOpening = !!oneTime && canCopy && copyState === null && !signInRequested;
  const copy = async () => {
    if (!oneTime) return false;
    const id = loginRef.current;
    try {
      await navigator.clipboard.writeText(oneTime);
      if (!current(id)) return false;
      setCopyState('copied');
      return true;
    } catch {
      if (!current(id)) return false;
      setCopyState('failed');
      const element = deviceCode.current;
      const selection = window.getSelection();
      if (element && selection) {
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return false;
    }
  };
  const openSignIn = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!copyBeforeOpening) {
      setSignInRequested(true);
      return;
    }
    // Keep the code visible until the browser confirms that it copied.
    event.preventDefault();
    if (openingRef.current || !link) return;
    const copying = copy();
    openingRef.current = copying;
    try {
      if (!(await copying) || openingRef.current !== copying || navigator.userActivation?.isActive === false) return;
      // Detect a blocked window and remove the opener and referrer before navigation.
      const tab = window.open('', '_blank');
      if (!tab) return;
      tab.opener = null;
      const provider = tab.document.createElement('a');
      provider.href = link;
      provider.rel = 'noreferrer';
      tab.document.body.append(provider);
      provider.click();
      setSignInRequested(true);
    } finally {
      if (openingRef.current === copying) openingRef.current = null;
    }
  };

  return (
    <div className={`connect-step${dedicated ? ' cs-dedicated' : ''}`} data-harness={harness} data-phase={phase} ref={step}>
      {dedicated ? (
        <span ref={signInStatus} className="cs-progress" role="status" tabIndex={-1}>
          {(!link || cancelling || verifying || waitingForBrowser) && <span className="cs-spinner" aria-hidden="true" />}
          {signInMessage}
        </span>
      ) : <CardHead
        name={harnessName(harness)}
        ok={phase === 'connected'}
        state={status}
        detail={phase === 'connected' && until ? until : undefined}
      >
        {actions}
      </CardHead>}
      {phase === 'failed' && (
        <Notice kind="error" className="cs-why">
          {why}
        </Notice>
      )}
      {phase === 'connecting' && (
        <div className="cs-login">
          {!dedicated && link && (
            <a className={buttonClass('primary', true, 'cs-open')} href={link} target="_blank" rel="noreferrer noopener">
              Open sign-in page
            </a>
          )}
          {!link && !dedicated && (
            <span className="nd-note cs-wait">Waiting for the sign-in page.</span>
          )}
          {oneTime && (
            <div className="cs-step">
              <span>Enter this code on the sign-in page:</span>
              <div className="cs-code-row">
                <strong className="cs-code" ref={deviceCode}>{oneTime}</strong>
                {dedicated && (
                  <Button kind="secondary" small onClick={() => void copy()}>
                    {copyState === 'copied' ? 'Copied' : 'Copy code'}
                  </Button>
                )}
              </div>
              {dedicated && copyState === 'failed' && (
                <span role="status">Couldn’t copy automatically. Copy the code manually before opening sign-in.</span>
              )}
              {dedicated && !canCopy && copyState === null && (
                <span className="nd-note">Copy the code manually before opening sign-in.</span>
              )}
              {!dedicated && <span className="nd-note">This step ends by itself once you sign in.</span>}
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
                <Button kind="secondary" small className="cs-send" onClick={send} disabled={!code.trim() || closed}>
                  {sending ? 'Sending…' : 'Send'}
                </Button>
              </div>
              {sendError && <Notice kind="error">{sendError}</Notice>}
            </div>
          )}
          {dedicated && (
            <div className="cs-sign-in-footer">
              {link && !cancelling && (
                <>
                  <a
                    className={buttonClass(signInRequested ? 'secondary' : 'primary', false, 'cs-open')}
                    href={link}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-describedby={signInHint}
                    onClick={openSignIn}
                  >
                    {signInRequested ? 'Reopen sign-in page' : copyBeforeOpening ? 'Copy code and open sign-in' : 'Open sign-in page'}
                  </a>
                  <span id={signInHint} className="nd-note">Opens a new tab. Return here after signing in.</span>
                </>
              )}
              {cancelError && <Notice kind="error">{cancelError}</Notice>}
              <Button kind="link" className="cs-cancel" onClick={leave}>
                {canReturnToSetup ? 'Back to setup' : 'Cancel sign-in'}
              </Button>
            </div>
          )}
        </div>
      )}
      {listError && <Notice kind="error">{listError}</Notice>}
    </div>
  );
};
