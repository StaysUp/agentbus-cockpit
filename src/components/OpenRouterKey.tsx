import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SubscriptionList } from '../types';
import { SubscriptionApi } from './ConnectStep';

// A key set once on control (PUT /api/v0/subscriptions/<name>/key): the
// OpenRouter key, added to every OpenRouter agent's calls, and each vendor's
// API key (anthropic, openai, gemini), added to the calls of that vendor's
// agents with access "API key". The key is typed into a password field, sent
// once, and then cleared: the page never holds it after Save and control
// never sends it back. Only "set" or "not set" is shown.
//
// A plain row, not a form: it sits inside the agent form too, where a nested
// form would submit the agent's form.

const day = (iso?: string) => (iso ? iso.slice(0, 10) : '');

// A vendor's API key, by its name in Settings.
export const vendorKeys: Record<string, { label: string; placeholder: string }> = {
  anthropic: { label: 'Anthropic API key', placeholder: 'sk-ant-…' },
  openai: { label: 'OpenAI API key', placeholder: 'sk-…' },
  gemini: { label: 'Gemini API key', placeholder: 'AIza…' },
};

type KeyState = { set: boolean; set_at?: string };

interface KeyRowProps {
  api: SubscriptionApi;
  // The key's name in Settings: openrouter, anthropic, openai or gemini.
  name: string;
  label: string;
  placeholder: string;
  // What is kept of it in the list; absent: a control too old to keep it.
  stateOf: (l: SubscriptionList) => KeyState | undefined;
  set?: (key: string) => Promise<void>;
  remove?: () => Promise<void>;
  // Class names for the row and its buttons ("or" for OpenRouter).
  cls: string;
  // Called after a save or remove worked: what depends on the key, such as
  // the list of models read with it, can be read again.
  onChange?: () => void;
}

const KeyRow: React.FC<KeyRowProps> = ({ api, name, label, placeholder, stateOf, set, remove, cls, onChange }) => {
  const [list, setList] = useState<SubscriptionList | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  // Replace was clicked: the field shows over a key that is set.
  const [replacing, setReplacing] = useState(false);
  // What the last write here did, shown until a list read after it
  // succeeds: a save or remove that worked shows so even when that read
  // fails.
  const [wrote, setWrote] = useState<KeyState | null>(null);
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
  const run = (write: () => Promise<void>, isSet: boolean) => {
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
          setWrote({ set: isSet });
          onChange?.();
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
    run(() => set!(k), true);
  };
  const forget = () => run(() => remove!(), false);

  if (list === undefined && error) return <div className="form-error">{error}</div>;
  // Not read yet, a service that keeps no subscriptions, or one too old to
  // keep this key: no row.
  const kept = list ? stateOf(list) : undefined;
  if (!set || !remove || !kept) return null;
  const st = wrote ?? kept;
  const field = !st.set || replacing;

  return (
    <div className={`connect-step key-row ${cls}-key`} data-harness={name} data-phase={st.set ? 'connected' : 'not-connected'}>
      <div className="cs-head">
        <span>{label}</span>
        <span className={`cs-status ${st.set ? 'ok' : 'off'}`}>{st.set ? 'set' : 'not set'}</span>
        {st.set && st.set_at && <span className="cs-until">since {day(st.set_at)}</span>}
        {st.set && !replacing && (
          <>
            <button type="button" className={`btn btn-secondary btn-sm cs-btn key-replace ${cls}-replace`} onClick={() => setReplacing(true)} disabled={busy}>
              Replace
            </button>
            <button type="button" className={`btn btn-secondary btn-sm cs-btn key-remove ${cls}-remove`} onClick={forget} disabled={busy}>
              Remove
            </button>
          </>
        )}
      </div>
      {field && (
        <div className="cs-step">
          <span>Paste your {label}. Control keeps it and never shows it again.</span>
          <div className="cs-input">
            <input
              type="password"
              name={`${name}_key`}
              aria-label={label}
              placeholder={placeholder}
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
            <button type="button" className={`btn btn-primary btn-sm cs-btn key-save ${cls}-save`} onClick={save} disabled={busy || !key.trim()}>
              {busy ? 'Saving' : 'Save'}
            </button>
            {replacing && (
              <button
                type="button"
                className={`btn btn-secondary btn-sm cs-btn key-cancel ${cls}-cancel`}
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

// The OpenRouter key. A service whose api has no setKey and removeKey shows
// no row.
export const OpenRouterKey: React.FC<{ api: SubscriptionApi }> = ({ api }) => (
  <KeyRow
    api={api}
    name="openrouter"
    label="OpenRouter key"
    placeholder="sk-or-…"
    stateOf={(l) => l.openrouter_key}
    set={api.setKey}
    remove={api.removeKey}
    cls="or"
  />
);

// One vendor's API key, by its name (vendorKeys). A service whose api cannot
// set it, or a control too old to list it, shows no row.
export const APIKey: React.FC<{ api: SubscriptionApi; name: string; onChange?: () => void }> = ({ api, name, onChange }) => {
  const v = vendorKeys[name] ?? { label: `${name} API key`, placeholder: '' };
  return (
    <KeyRow
      api={api}
      name={name}
      label={v.label}
      placeholder={v.placeholder}
      stateOf={(l) => l.api_keys?.[name]}
      set={api.setAPIKey ? (k) => api.setAPIKey!(name, k) : undefined}
      remove={api.removeAPIKey ? () => api.removeAPIKey!(name) : undefined}
      cls="api"
      onChange={onChange}
    />
  );
};
