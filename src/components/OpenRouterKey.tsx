import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SubscriptionList } from '../types';
import { CardHead, SubscriptionApi } from './ConnectStep';
import { Button } from './Controls';
import { ConfirmDialog } from './Dialog';
import { Notice } from './Notice';
import { harnessName } from '../words';

// A key set once in AgentBus (PUT /api/v0/subscriptions/<name>/key): the
// OpenRouter key, added to every OpenRouter agent's calls, and each vendor's
// API key (anthropic, openai, gemini), added to the calls of that vendor's
// agents with access "API key". The key is typed into a password field, sent
// once, and then cleared: the page never holds it after Save and AgentBus
// never sends it back. Only "set" or "not set" is shown.
//
// A plain row, not a form: it sits inside the agent form too, where a nested
// form would submit the agent's form.

const day = (iso?: string) => (iso ? iso.slice(0, 10) : '');

// A vendor's API key, by its name in Settings, and the harness whose
// agents use it.
export const vendorKeys: Record<string, { label: string; placeholder: string; harness: string }> = {
  anthropic: { label: 'Anthropic API key', placeholder: 'sk-ant-…', harness: 'claude' },
  openai: { label: 'OpenAI API key', placeholder: 'sk-…', harness: 'codex' },
  gemini: { label: 'Gemini API key', placeholder: 'AIza…', harness: 'agy' },
  xai: { label: 'xAI API key', placeholder: 'xai-…', harness: 'opencode' },
};

type KeyState = { set: boolean; set_at?: string };

interface KeyRowProps {
  api: SubscriptionApi;
  // The key's name in Settings: openrouter, anthropic, openai or gemini.
  name: string;
  label: string;
  placeholder: string;
  // The one line under the row's head: what uses the key.
  note: string;
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

const KeyRow: React.FC<KeyRowProps> = ({ api, name, label, placeholder, note, stateOf, set, remove, cls, onChange }) => {
  const [list, setList] = useState<SubscriptionList | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  // Set key or Replace was clicked: the field shows until a save works or
  // Cancel is clicked.
  const [open, setOpen] = useState(false);
  // Remove was clicked: it asks first, as every remove with a lasting
  // effect does (agents using the key stop working).
  const [asking, setAsking] = useState(false);
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
          setOpen(false);
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
  // Remove, after the confirm: its answer shows in the confirm, and the
  // list read after it says what is kept.
  const forget = async () => {
    await remove!();
    if (!alive.current) return;
    setKey('');
    setOpen(false);
    setWrote({ set: false });
    onChange?.();
    reload();
  };

  if (list === undefined && error) return <Notice kind="error">{error}</Notice>;
  // Not read yet, a service that keeps no subscriptions, or one too old to
  // keep this key: no row.
  const kept = list ? stateOf(list) : undefined;
  if (!set || !remove || !kept) return null;
  const st = wrote ?? kept;
  const cancel = () => {
    setOpen(false);
    setKey('');
  };

  // Laid out as a subscription's row (ConnectStep): the name, set or not,
  // and one action at the right; the field opens under it on Set key or
  // Replace; one line says what uses the key.
  return (
    <div className={`connect-step key-row ${cls}-key`} data-harness={name} data-phase={st.set ? 'connected' : 'not-connected'}>
      <CardHead name={label} ok={st.set} state={st.set ? 'set' : 'not set'} detail={st.set && st.set_at ? `since ${day(st.set_at)}` : undefined}>
        {open ? (
          <Button kind="secondary" small className={`key-cancel ${cls}-cancel`} onClick={cancel} disabled={busy}>
            Cancel
          </Button>
        ) : st.set ? (
          <>
            <Button kind="secondary" small className={`key-replace ${cls}-replace`} onClick={() => setOpen(true)} disabled={busy}>
              Replace
            </Button>
            <Button kind="secondary" small className={`key-remove ${cls}-remove`} onClick={() => setAsking(true)} disabled={busy}>
              Remove
            </Button>
          </>
        ) : (
          <Button kind="secondary" small className={`key-set ${cls}-set`} onClick={() => setOpen(true)} disabled={busy}>
            Set key
          </Button>
        )}
      </CardHead>
      {asking && (
        <ConfirmDialog
          className={`key-remove-ask ${cls}-remove-ask`}
          title={`Remove the ${label}?`}
          line="Agents that use it cannot run until a key is set again."
          action="Remove"
          busyAction="Removing…"
          onConfirm={forget}
          onClose={() => setAsking(false)}
        />
      )}
      {open && (
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
          <Button kind="primary" small className={`key-save ${cls}-save`} onClick={save} disabled={busy || !key.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
      {error && (
        <Notice kind="error" className="cs-why">
          {error}
        </Notice>
      )}
      <span className="nd-note">{note}</span>
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
    note="Used by agents on OpenRouter."
    stateOf={(l) => l.api_keys?.openrouter}
    set={api.setKey}
    remove={api.removeKey}
    cls="or"
  />
);

// One vendor's API key, by its name (vendorKeys). A service whose api cannot
// set it, or one too old to list it, shows no row.
export const APIKey: React.FC<{ api: SubscriptionApi; name: string; onChange?: () => void }> = ({ api, name, onChange }) => {
  const v = vendorKeys[name] ?? { label: `${name} API key`, placeholder: '', harness: name };
  return (
    <KeyRow
      api={api}
      name={name}
      label={v.label}
      placeholder={v.placeholder}
      note={`Used by ${harnessName(v.harness)} agents on an API key.`}
      stateOf={(l) => l.api_keys?.[name]}
      set={api.setAPIKey ? (k) => api.setAPIKey!(name, k) : undefined}
      remove={api.removeAPIKey ? () => api.removeAPIKey!(name) : undefined}
      cls="api"
      onChange={onChange}
    />
  );
};
