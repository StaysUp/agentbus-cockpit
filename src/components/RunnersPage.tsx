import React, { useEffect, useState } from 'react';
import { ApiTurn } from '../data/jobs';
import { PendingMachine, RunnerInfo, SandboxInfo } from '../types';
import { formatAgo } from '../utils/format';
import { ColHead, PageFrame } from './PageFrame';
import { RunnersList, RunnersState } from './RunnersList';

// What the person decides on the page: approve a waiting machine with the
// code it shows, refuse it, or remove an offline runner. Each rejects with
// the API's own words.
export interface RunnerActions {
  approve: (id: string, code: string) => Promise<void>;
  refuse: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

interface RunnersPageProps extends RunnersState {
  onBack: () => void;
  // The turn list, when the service keeps a queue: its queued and running
  // turns make the Queue column. Undefined when it keeps none.
  queue?: { turns: ApiTurn[]; error: string | null };
  // Undefined: a source that cannot decide, and the page shows no buttons.
  actions?: RunnerActions;
}

const Sep = () => <span className="sep">·</span>;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The runners page (/runners), in the mockup's three columns: every machine,
// one runner each, with the machines waiting for approval on top; the picked
// one, with what it reported; and the queue.
export const RunnersPage: React.FC<RunnersPageProps> = ({ runners, error, pending, reload, onBack, queue, actions }) => {
  const [picked, setPicked] = useState<string | null>(null);
  const waiting = pending ?? [];
  // The picked one while it is listed; else the first runner, or with no
  // runner the first machine waiting. A pick that left the list on a later
  // read (approved, refused, expired, removed) falls back the same way.
  const pickedPending = waiting.find((p) => p.id === picked);
  const pickedRunner = pickedPending ? undefined : runners?.find((r) => r.id === picked);
  const shownPending = pickedPending ?? (!pickedRunner && !runners?.length ? waiting[0] : undefined);
  const shown = shownPending ? undefined : (pickedRunner ?? runners?.[0]);
  const after = () => {
    setPicked(null);
    reload?.();
  };
  return (
    <PageFrame
      title="Runners"
      onBack={onBack}
      list={
        <>
          {waiting.length > 0 && <PendingList pending={waiting} selected={shownPending?.id} onSelect={setPicked} />}
          {runners === undefined && !error && <p className="dim runners-none">Reading…</p>}
          {runners === null && <p className="dim runners-none">This service keeps no runners.</p>}
          <RunnersList runners={runners} error={error} selected={shown?.id} onSelect={setPicked} />
        </>
      }
      foot={
        <>
          <code>agentbus login</code> with this control's address adds a machine. It waits here for approval.
        </>
      }
      main={
        shownPending ? (
          <PendingDetail key={shownPending.id} p={shownPending} actions={actions} onDone={after} />
        ) : shown ? (
          <RunnerDetail key={shown.id} r={shown} actions={actions} onDone={after} />
        ) : (
          <ColHead title="No runner" />
        )
      }
      side={<Queue queue={queue} />}
    />
  );
};

// SandboxNote says whether a machine can build a session's wall.
const SandboxNote: React.FC<{ s?: SandboxInfo }> = ({ s }) => {
  if (!s) return <span className="dim">not reported</span>;
  if (s.can) return <span className="rn-chip">can build it</span>;
  return (
    <span className="rn-sandbox-no">
      cannot{s.why ? <span className="dim">: {s.why}</span> : null}
    </span>
  );
};

// The machines waiting for approval, as rows above the runners.
const PendingList: React.FC<{ pending: PendingMachine[]; selected?: string; onSelect: (id: string) => void }> = ({
  pending,
  selected,
  onSelect,
}) => (
  <div className="runners rn-pending" aria-label="Waiting for approval">
    <div className="sub-h">Waiting for approval</div>
    {pending.map((p) => {
      const on = selected === p.id;
      return (
        <button
          type="button"
          key={p.id}
          className={`prow runner pending${on ? ' on' : ''}`}
          data-pending={p.id}
          aria-current={on}
          title={p.id}
          onClick={() => onSelect(p.id)}
        >
          <span className="pr-n">
            <span>
              <i className="rn-dot pending" aria-label="waiting" />
              {p.name}
            </span>
          </span>
          <span className="pr-m2">
            waiting
            <Sep />
            asked {formatAgo(p.asked) || 'now'}
          </span>
        </button>
      );
    })}
  </div>
);

// One waiting machine: what it reported, and Approve with its code, or Refuse.
const PendingDetail: React.FC<{ p: PendingMachine; actions?: RunnerActions; onDone: () => void }> = ({ p, actions, onDone }) => {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = (f: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    f().then(
      () => onDone(),
      (e: unknown) => {
        setBusy(false);
        setErr(e instanceof Error ? e.message : String(e));
      }
    );
  };
  return (
    <>
      <ColHead
        title={
          <>
            <i className="rn-dot pending" />
            {p.name}
          </>
        }
        sub="waiting for approval"
      />
      <div className="colbody pg-body">
        <p className="pg-note">
          This machine ran <code>agentbus login</code> and takes no work until you approve it. Anyone who can reach this
          control can ask, so check the code: type the one that machine shows.
        </p>
        <table className="grid pg-kv">
          <tbody>
            <tr>
              <td>OS</td>
              <td>{p.os ? <span className="rn-chip">{[p.os, p.arch].filter(Boolean).join(' ')}</span> : <span className="dim">not reported</span>}</td>
            </tr>
            <tr>
              <td>Sandbox</td>
              <td>
                <SandboxNote s={p.sandbox} />
              </td>
            </tr>
            <tr>
              <td>Labels</td>
              <td>{p.labels.length ? p.labels.map((l) => <span key={l} className="rn-chip">{l}</span>) : <span className="dim">none</span>}</td>
            </tr>
            <tr>
              <td>Asked</td>
              <td>
                {new Date(p.asked).toLocaleString()} <Sep /> waits until {new Date(p.expires).toLocaleTimeString()}
              </td>
            </tr>
          </tbody>
        </table>
        {actions && (
          <form
            className="rn-approve"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) act(() => actions.approve(p.id, code.trim()));
            }}
          >
            <label>
              Code shown on the machine{' '}
              <input
                aria-label="Code shown on the machine"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="XXXX-XXXX"
                autoComplete="off"
                spellCheck={false}
                maxLength={16}
              />
            </label>{' '}
            <button type="submit" className="rn-btn primary" disabled={busy || !code.trim()}>
              Approve
            </button>{' '}
            <button type="button" className="rn-btn" disabled={busy} onClick={() => act(() => actions.refuse(p.id))}>
              Refuse
            </button>
          </form>
        )}
        {err && <p className="form-error">{err}</p>}
      </div>
    </>
  );
};

const RunnerDetail: React.FC<{ r: RunnerInfo; actions?: RunnerActions; onDone: () => void }> = ({ r, actions, onDone }) => {
  const connector = r.role === 'connector';
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setErr(null), [r.id]);
  const remove = () => {
    if (!actions) return;
    if (!window.confirm(`Remove ${r.name}? Its credential stops working, so it takes no more work. Its sessions stay in the record.`)) return;
    setBusy(true);
    setErr(null);
    actions.remove(r.id).then(
      () => onDone(),
      (e: unknown) => {
        setBusy(false);
        setErr(e instanceof Error ? e.message : String(e));
      }
    );
  };
  const found = r.harnesses.filter((h) => h.found);
  const signedIn = found.filter((h) => h.signed_in);
  const chips = (xs: string[], none: string) =>
    xs.length ? xs.map((x) => <span key={x} className="rn-chip">{x}</span>) : <span className="dim">{none}</span>;
  return (
    <>
      <ColHead
        title={
          <>
            <i className={`rn-dot ${r.online ? 'online' : 'offline'}`} />
            {r.name}
          </>
        }
        sub={connector ? 'connector' : 'runner'}
      />
      <div className="colbody pg-body">
        <div className="tab-sum">
          <b>{r.online ? 'Online' : 'Offline'}</b>
          <Sep />
          last seen {formatAgo(r.last_seen) || 'never'}
          {r.capacity !== undefined && (
            <>
              <Sep />
              {plural(r.capacity, 'turn')} at once
            </>
          )}
        </div>
        {connector && (
          <p className="pg-note">A connector from before 0.5. It takes no work now: run agentbus runner on this machine instead.</p>
        )}
        <table className="grid pg-kv">
          <tbody>
            {!connector && (
              <>
                <tr>
                  <td>Harnesses</td>
                  <td>{chips(found.map((h) => (h.version ? `${h.name} ${h.version}` : h.name)), 'none found')}</td>
                </tr>
                <tr>
                  <td>Signed in</td>
                  <td>{chips(signedIn.map((h) => h.name), 'none')}</td>
                </tr>
              </>
            )}
            <tr>
              <td>OS</td>
              <td>{r.os ? chips([[r.os, r.arch].filter(Boolean).join(' ')], '') : <span className="dim">not reported yet</span>}</td>
            </tr>
            {!connector && (
              <tr>
                <td>Sandbox</td>
                <td>
                  <SandboxNote s={r.sandbox} />
                </td>
              </tr>
            )}
            <tr>
              <td>Labels</td>
              <td>{chips(r.labels, 'none')}</td>
            </tr>
            {r.enrolled && (
              <tr>
                <td>Enrolled</td>
                <td>{new Date(r.enrolled).toLocaleString()}</td>
              </tr>
            )}
            {r.connector && (
              <tr>
                <td>Machine</td>
                <td>
                  <code>{r.connector}</code>
                </td>
              </tr>
            )}
            <tr>
              <td>Id</td>
              <td>
                <code>{r.id}</code>
              </td>
            </tr>
          </tbody>
        </table>
        {!connector && r.harnesses.length > 0 && (
          <>
            <div className="sub-h">Harnesses</div>
            <table className="grid rn-harnesses">
              <thead>
                <tr>
                  <th>Harness</th>
                  <th>Version</th>
                  <th>Signed in</th>
                </tr>
              </thead>
              <tbody>
                {r.harnesses.map((h) => (
                  <tr key={h.name} className={h.found ? '' : 'off'}>
                    <td>{h.name}</td>
                    <td className="t">{h.found ? h.version || '–' : <span className="dim">not found</span>}</td>
                    <td>{h.found ? (h.signed_in ? 'yes' : 'no') : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {actions && !r.online && (
          <p className="rn-remove">
            <button type="button" className="rn-btn" disabled={busy} onClick={remove}>
              Remove
            </button>{' '}
            <span className="dim">Offline. Removing it revokes its credential; run agentbus login on it to add it again.</span>
          </p>
        )}
        {err && <p className="form-error">{err}</p>}
      </div>
    </>
  );
};

// Queue is the turns still waiting for a runner, and those running now.
const Queue: React.FC<{ queue?: { turns: ApiTurn[]; error: string | null } }> = ({ queue }) => {
  if (!queue) {
    return (
      <>
        <ColHead title="Queue" />
        <div className="colbody pg-body">
          <p className="f-note first">This service keeps no queue.</p>
        </div>
      </>
    );
  }
  const waiting = queue.turns.filter((t) => t.state === 'queued');
  const running = queue.turns.filter((t) => t.state === 'running');
  const what = (t: ApiTurn) => (
    <>
      <span className="rn-prompt">{t.prompt || t.id}</span>
      <div className="note">
        {t.agent || 'agent'}
        {t.number ? ` · turn ${t.number}` : ''}
        {' · '}
        <code>{t.session}</code>
      </div>
    </>
  );
  return (
    <>
      <ColHead title="Queue" />
      <div className="colbody pg-body">
        {queue.error && <p className="form-error">{queue.error}</p>}
        <div className="tab-sum">
          <b>{waiting.length} waiting</b>
          <Sep />
          {running.length} running
        </div>
        {waiting.length > 0 && (
          <table className="grid rn-queue" aria-label="Waiting">
            <thead>
              <tr>
                <th>Turn</th>
                <th>Why it waits</th>
                <th>Asked</th>
              </tr>
            </thead>
            <tbody>
              {waiting.map((t) => (
                <tr key={t.id} data-turn={t.id}>
                  <td>{what(t)}</td>
                  <td className="dim">
                    {t.ahead ? `${plural(t.ahead, 'earlier turn')} of its session` : 'for a free runner'}
                  </td>
                  <td className="t">{formatAgo(t.asked) || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="sub-h">Running now</div>
        {running.length > 0 ? (
          <table className="grid rn-queue" aria-label="Running">
            <thead>
              <tr>
                <th>Turn</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {running.map((t) => (
                <tr key={t.id} data-turn={t.id}>
                  <td>{what(t)}</td>
                  <td className="t">{formatAgo(t.started) || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="f-note first">Nothing.</p>
        )}
      </div>
    </>
  );
};
