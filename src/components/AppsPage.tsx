import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ColHead, PageFrame } from './PageFrame';
import { Button } from './Controls';
import { ConfirmDialog } from './Dialog';
import { Loading, Notice } from './Notice';
import { AppDef, AppSummary, AppWorkflow } from '../types';

// The Apps page (/apps): the apps AgentBus serves to agents — our reusable
// capabilities and the person's own. The left column lists them; picking one
// shows what it does in the middle and its full definition on the right. The
// list carries facts only, so each app's definition is loaded on its own from
// the single app route. "+ App" adds a custom app; an app can be removed.

export interface AppsApi {
  // The apps as facts only (GET /api/v0/tools).
  listApps(): Promise<AppSummary[]>;
  // One app's full definition (GET /api/v0/tools/{name}).
  getApp(name: string): Promise<AppDef>;
  // Add a custom app (POST /api/v0/tools); rejects with the API's own words.
  addApp(def: AppDef): Promise<AppDef>;
  // Remove an app by name (DELETE /api/v0/tools/{name}).
  removeApp(name: string): Promise<void>;
}

interface AppsPageProps {
  api: AppsApi;
  onBack: () => void;
  // The foot nav targets, passed to PageFrame. The Apps row is left out here.
  onRunners?: () => void;
  onSettings?: () => void;
  runnersOnline?: number;
  version?: string;
  sourceLabel?: string;
  streamUp?: boolean;
  onDisconnect?: () => void;
  disconnectLabel?: string;
}

// whereLabel is where an app's call runs, in the cockpit's own words. A call
// on a named runner shows that runner's name; every other case (the API side,
// the only one in 0.6) is the service itself, AgentBus.
export function whereLabel(where: string): string {
  const prefix = 'runner:';
  return where && where.startsWith(prefix) ? where.slice(prefix.length) : 'AgentBus';
}

// A new custom app starts from this: a reads app that calls an AgentBus route.
const SKELETON = `{
  "name": "verb_noun",
  "description": "What it does; its scope first, then what it does not.",
  "inputs": { "type": "object", "properties": {} },
  "run": { "kind": "api", "method": "GET", "path": "/api/v0/turns" }
}`;

export const AppsPage: React.FC<AppsPageProps> = ({
  api,
  onBack,
  onRunners,
  onSettings,
  runnersOnline,
  version,
  sourceLabel,
  streamUp,
  onDisconnect,
  disconnectLabel,
}) => {
  const [apps, setApps] = useState<AppSummary[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [def, setDef] = useState<AppDef | null>(null);
  const [defErr, setDefErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addText, setAddText] = useState(SKELETON);
  const [addErr, setAddErr] = useState<string | null>(null);
  // One list operation runs at a time. While an add or remove and its refresh
  // are in flight, busy disables the controls that would start another action
  // or change the view, so no completion lands on a page the person has since
  // moved on from. With the loadSeq guard (a superseded list is dropped), this
  // is the one rule that makes the stale-completion races impossible rather
  // than guarding each call site on its own.
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<AppSummary | null>(null);
  const alive = useRef(true);
  // Each list read gets the next number; only the newest one's result is kept.
  // A read started later (the refresh after an add or a remove) always wins
  // over one started earlier, whatever order they return in, so a slow initial
  // read cannot overwrite a fresh list and hide a just-added app.
  const loadSeq = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setListErr(null);
    try {
      const list = await api.listApps();
      if (!alive.current || seq !== loadSeq.current) return;
      setApps(list);
    } catch (err) {
      if (!alive.current || seq !== loadSeq.current) return;
      setApps([]);
      setListErr((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  // The picked app's full definition, read on its own from the single app
  // route. A change of pick drops the old one first, so nothing stale shows.
  useEffect(() => {
    if (picked === null) {
      setDef(null);
      setDefErr(null);
      return;
    }
    let live = true;
    setDef(null);
    setDefErr(null);
    api.getApp(picked).then(
      (d) => {
        if (live) setDef(d);
      },
      (err) => {
        if (live) setDefErr((err as Error).message);
      }
    );
    return () => {
      live = false;
    };
  }, [api, picked]);

  const pick = (name: string) => {
    setAdding(false);
    setPicked(name);
  };

  const openAdd = () => {
    setPicked(null);
    setAddErr(null);
    setAddText(SKELETON);
    setAdding(true);
  };

  const submitAdd = async () => {
    let parsed: AppDef;
    try {
      parsed = JSON.parse(addText) as AppDef;
    } catch {
      setAddErr('That is not valid JSON.');
      return;
    }
    setBusy(true);
    setAddErr(null);
    try {
      const saved = await api.addApp(parsed);
      if (!alive.current) return;
      // The list and the view both change only now, with nothing else able to
      // have started meanwhile (busy held the controls), so this cannot close
      // a newer draft or override a pick made since.
      await load();
      if (!alive.current) return;
      setAdding(false);
      setPicked(saved.name);
    } catch (err) {
      if (alive.current) setAddErr((err as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  // The left column: a button to add, then one row per app.
  const list = (
    <nav className="apps-list" aria-label="Apps">
      <Button kind="secondary" small className="apps-add" disabled={busy} onClick={openAdd}>
        + App
      </Button>
      {apps === null && !listErr ? (
        <Loading />
      ) : listErr ? (
        <Notice kind="error" className="apps-list-err">
          {listErr}
        </Notice>
      ) : apps && apps.length === 0 ? (
        <p className="empty">No apps.</p>
      ) : (
        (apps ?? []).map((a) => (
          <button
            key={a.name}
            type="button"
            className={`pick apps-row${picked === a.name ? ' on' : ''}`}
            aria-current={picked === a.name ? 'true' : undefined}
            disabled={busy}
            onClick={() => pick(a.name)}
          >
            <span className="apps-row-name">{a.name}</span>
          </button>
        ))
      )}
    </nav>
  );

  // The middle column: the add form, the picked app's facts, or a hint.
  const summary = apps?.find((a) => a.name === picked);
  let main: React.ReactNode;
  if (adding) {
    main = (
      <>
        <ColHead title="Add an app" />
        <div className="colbody pg-body apps-main">
          <p className="pg-note">
            An app is one definition: a name, a description for a model, its inputs and what it runs — one AgentBus API
            route (kind api), or a workflow of several (kind app). Paste or edit the definition below.
          </p>
          {/* While busy every control of the form is held — the field and
              both buttons — so an edit or a second submit made during the add
              and its refresh cannot be lost or land on a changed page. */}
          <textarea
            className="pg-text apps-text"
            aria-label="App definition"
            spellCheck={false}
            disabled={busy}
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
          />
          {addErr && (
            <Notice kind="error" className="apps-add-err">
              {addErr}
            </Notice>
          )}
          <div className="apps-actions">
            <Button kind="secondary" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button kind="primary" disabled={busy} onClick={submitAdd}>
              {busy ? 'Adding…' : 'Add app'}
            </Button>
          </div>
        </div>
      </>
    );
  } else if (picked && summary) {
    main = (
      <>
        <ColHead title={summary.name} />
        <div className="colbody pg-body apps-main">
          <p className="apps-desc">{summary.description}</p>
          <dl className="apps-facts">
            <div>
              <dt>Where it runs</dt>
              <dd>{whereLabel(summary.where)}</dd>
            </div>
          </dl>
          <div className="apps-actions">
            <Button kind="secondary" small disabled={busy} onClick={() => setRemoving(summary)}>
              Remove
            </Button>
          </div>
        </div>
      </>
    );
  } else {
    main = (
      <>
        <ColHead title="Apps" />
        <div className="colbody pg-body apps-main">
          <p className="empty">Pick an app to see what it does, or add one.</p>
        </div>
      </>
    );
  }

  // The right column: the picked app's full definition (inputs and run).
  let side: React.ReactNode = null;
  if (picked && !adding) {
    side = (
      <>
        <ColHead title="Definition" />
        <div className="colbody pg-body apps-side">
          {defErr ? (
            <Notice kind="error">{defErr}</Notice>
          ) : def === null ? (
            <Loading />
          ) : (
            <Definition def={def} />
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {removing && (
        <ConfirmDialog
          title="Remove app"
          line={
            <>
              Remove <b>{removing.name}</b>? Agents stop seeing it. A built-in can be added again later.
            </>
          }
          action="Remove"
          busyAction="Removing…"
          onConfirm={async () => {
            await api.removeApp(removing.name);
            if (!alive.current) return;
            if (picked === removing.name) setPicked(null);
            await load();
          }}
          onClose={() => setRemoving(null)}
        />
      )}
      <PageFrame
        title="Apps"
        current="apps"
        onBack={onBack}
        onRunners={onRunners}
        onSettings={onSettings}
        runnersOnline={runnersOnline}
        version={version}
        sourceLabel={sourceLabel}
        streamUp={streamUp}
        onDisconnect={onDisconnect}
        disconnectLabel={disconnectLabel}
        list={list}
        main={main}
        side={side}
      />
    </>
  );
};

// Steps shows an app's workflow as a readable sequence (B15): one row per step,
// the operation it calls and where each of its values comes from ($inputs, an
// earlier step's output, or the caller). This is the proof an app is data: a
// person can read exactly what it does, built-in or their own.
const Steps: React.FC<{ app: AppWorkflow }> = ({ app }) => {
  const steps = Array.isArray(app.steps) ? app.steps : [];
  const values = (m?: Record<string, unknown>) => (m && typeof m === 'object' ? Object.entries(m) : []);
  return (
    <ol className="apps-steps">
      {steps.map((s, i) => {
        const vals = [...values(s.requestBody), ...values(s.parameters)];
        return (
          <li key={s.stepId || i} className="apps-step">
            <code className="apps-op">{s.operationId}</code>
            {vals.length > 0 && (
              <dl className="apps-step-vals">
                {vals.map(([field, v]) => (
                  <div key={field}>
                    <dt>
                      <code>{field}</code>
                    </dt>
                    <dd>
                      <code className="apps-expr">{asText(v)}</code>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        );
      })}
    </ol>
  );
};

// asText shows a schema value the API did not force to a string. A property's
// type or description is free JSON (the registry's schema check does not pin
// them to strings), so a bare render could be an object — which React throws
// on, clearing the page. A string shows as itself; anything else as its JSON;
// null and undefined show nothing.
function asText(v: unknown): string | null {
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

// Definition shows an app's full definition: what it runs, then its inputs.
const Definition: React.FC<{ def: AppDef }> = ({ def }) => {
  const rawProps = def.inputs?.properties;
  const props: Record<string, unknown> =
    rawProps && typeof rawProps === 'object' && !Array.isArray(rawProps) ? (rawProps as Record<string, unknown>) : {};
  const req = def.inputs?.required;
  const required = new Set(Array.isArray(req) ? req.filter((x): x is string => typeof x === 'string') : []);
  const names = Object.keys(props);
  return (
    <>
      <div className="sub-h">Runs</div>
      {def.run.kind === 'api' ? (
        <p className="apps-run">
          <span className="apps-run-m">{def.run.method}</span> <code className="apps-run-p">{def.run.path}</code>
        </p>
      ) : def.run.kind === 'app' && def.run.app ? (
        <Steps app={def.run.app} />
      ) : (
        <p className="apps-run">{def.run.kind}</p>
      )}

      <div className="sub-h">Inputs</div>
      {names.length === 0 ? (
        <p className="dim">None.</p>
      ) : (
        <dl className="apps-inputs">
          {names.map((n) => {
            const p = (props[n] && typeof props[n] === 'object' ? props[n] : {}) as Record<string, unknown>;
            const type = asText(p.type);
            const desc = asText(p.description);
            return (
              <div key={n}>
                <dt>
                  <code>{n}</code>
                  {type && <span className="apps-in-t">{type}</span>}
                  {required.has(n) && <span className="apps-in-req">required</span>}
                </dt>
                {desc && <dd>{desc}</dd>}
              </div>
            );
          })}
        </dl>
      )}
    </>
  );
};
