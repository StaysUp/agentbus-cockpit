import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SubscriptionList } from '../types';
import { SubscriptionApi } from './ConnectStep';

// The OpenRouter key, set once on control (PUT /api/v0/subscriptions/
// openrouter/key) and added to every OpenRouter agent's calls. The key is
// typed into a password field, sent once, and then cleared: the page never
// holds it after Save and control never sends it back. Only "set" or "not
// set" is shown.
//
// A plain row, not a form: it sits inside the agent form too, where a nested
// form would submit the agent's form.

const day = (iso?: string) => (iso ? iso.slice(0, 10) : '');

// A service whose api has no setKey and removeKey shows no row.
export const OpenRouterKey: React.FC<{ api: SubscriptionApi }> = ({ api }) => {
  const [list, setList] = useState<SubscriptionList | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  // Replace was clicked: the field shows over a key that is set.
  const [replacing, setReplacing] = useState(false);
  // What the last write here did, shown until a list read after it
  // succeeds: a save or remove that worked shows so even when that read
  // fails.
  const [wrote, setWrote] = useState<{ set: boolean; set_at?: string } | null>(null);
  const busyRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(
    () =>
      api.list().then(
        (l) => {
          if (!alive.current) return;
          setList(l);
          setWrote(null);
        },
        (e: Error) => alive.current && setError(e.message),
      ),
    [api],
  );
  useEffect(() => {
    reload();
  }, [reload]);

  // One write at a time; its answer then the list again say what is kept.
  const run = (write: () => Promise<void>, set: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    write()
      .then(
        () => {
          if (!alive.current) return;
          setKey('');
          setReplacing(false);
          setWrote({ set });
          return reload();
        },
        (e: Error) => alive.current && setError(e.message),
      )
      .finally(() => {
        busyRef.current = false;
        if (alive.current) setBusy(false);
      });
  };
  const save = () => {
    const k = key.trim();
    if (!k) return;
    run(() => api.setKey!(k), true);
  };
  const remove = () => run(() => api.removeKey!(), false);

  if (list === undefined && error) return <div className="form-error">{error}</div>;
  // Not read yet, a service that keeps no subscriptions, or one too old to
  // keep a key: no row.
  if (!api.setKey || !api.removeKey || !list?.openrouter_key) return null;
  const st = wrote ?? list.openrouter_key;
  const field = !st.set || replacing;

  return (
    <div className="connect-step or-key" data-harness="openrouter" data-phase={st.set ? 'connected' : 'not-connected'}>
      <div className="cs-head">
        <span>OpenRouter key</span>
        <span className={`cs-status ${st.set ? 'ok' : 'off'}`}>{st.set ? 'set' : 'not set'}</span>
        {st.set && st.set_at && <span className="cs-until">since {day(st.set_at)}</span>}
        {st.set && !replacing && (
          <>
            <button type="button" className="btn btn-secondary btn-sm cs-btn or-replace" onClick={() => setReplacing(true)} disabled={busy}>
              Replace
            </button>
            <button type="button" className="btn btn-secondary btn-sm cs-btn or-remove" onClick={remove} disabled={busy}>
              Remove
            </button>
          </>
        )}
      </div>
      {field && (
        <div className="cs-step">
          <span>Paste your OpenRouter key. Control keeps it and never shows it again.</span>
          <div className="cs-input">
            <input
              type="password"
              name="openrouter_key"
              aria-label="OpenRouter key"
              placeholder="sk-or-…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  save();
                }
              }}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
            <button type="button" className="btn btn-primary btn-sm cs-btn or-save" onClick={save} disabled={busy || !key.trim()}>
              {busy ? 'Saving' : 'Save'}
            </button>
            {replacing && (
              <button
                type="button"
                className="btn btn-secondary btn-sm cs-btn or-cancel"
                onClick={() => {
                  setReplacing(false);
                  setKey('');
                }}
                disabled={busy}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
      {error && <div className="form-error cs-why">{error}</div>}
    </div>
  );
};
