import React, { useEffect, useState } from 'react';
import { ApiTurn } from '../data/jobs';
import { CloseState, PendingMachine, RunnerInfo, WorkspaceRow } from '../types';
import { formatAgo } from '../utils/format';
import { ColHead, PageFrame } from './PageFrame';
import { RunnersList, RunnersState } from './RunnersList';
import { Button } from './Controls';
import { ConfirmDialog } from './Dialog';
import { Notice } from './Notice';
import { useWorkspaces, WorkspacesApi, WorkspacesTable } from './Workspaces';
import { FolderInfo } from '../data/folders';
import { harnessName, LOADING, PRODUCT, STATE } from '../words';

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
  // The foot nav targets, passed through to PageFrame: the sibling pages and
  // the Feedback box. The Runners row is left out here (this is that page).
  onApps?: () => void;
  onRunners?: () => void;
  onSettings?: () => void;
  runnersOnline?: number;
  version?: string;
  // The AgentBus card at the foot, the same as the cockpit's.
  sourceLabel?: string;
  streamUp?: boolean;
  onDisconnect?: () => void;
  disconnectLabel?: string;
  // The turn list, when the service keeps a queue: its queued and running
  // turns make the Queue column. Undefined when it keeps none.
  queue?: { turns: ApiTurn[]; error: string | null; titleOf?: (session: string) => string | undefined };
  // Undefined: a source that cannot decide, and the page shows no buttons.
  actions?: RunnerActions;
  // The workspaces, on the page of the machine that holds each, with Close.
  // Undefined: a source without them, and none are shown.
  workspaces?: WorkspacesApi;
  // The folders the service lists, to name a workspace's folder by its ref.
  folders?: FolderInfo[];
}

const Sep = () => <span className="sep">·</span>;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The runners page (/runners), in the mockup's three columns: every machine,
// one runner each, with the machines waiting for approval on top; the picked
// one, with what it reported; and the queue.
export const RunnersPage: React.FC<RunnersPageProps> = ({ runners, error, pending, reload, onBack, onApps, onRunners, onSettings, runnersOnline, version, sourceLabel, streamUp, onDisconnect, disconnectLabel, queue, actions, workspaces, folders }) => {
  const [picked, setPicked] = useState<string | null>(null);
  const ws = useWorkspaces(workspaces);
  const waiting = pending ?? [];
  // The picked one while it is listed; else the first runner, or with no
  // runner the first machine waiting. A pick that left the list on a later
  // read (approved, refused, expired, removed) falls back the same way.
  const pickedPending = waiting.find((p) => p.id === picked);
  const pickedRunner = pickedPending ? undefined : runners?.find((r) => r.id === picked);
  const shownPending = pickedPending ?? (!pickedRunner && !runners?.length ? waiting[0] : undefined);
  const shown = shownPending ? undefined : (pickedRunner ?? runners?.[0]);
  // The shown runner's open workspaces. A workspace with no machine id is on
  // the service's own machine. The API does not say which runner that is, so
  // the first runner listed takes them: the only one, in agentbus up.
  const home = runners?.find((r) => r.role !== 'connector' && r.machine);
  const wsOf = (r: RunnerInfo): WorkspaceRow[] =>
    (ws.rows ?? []).filter((w) => (w.machine ? w.machine === r.machine : r.id === home?.id));
  const after = () => {
    setPicked(null);
    reload?.();
  };
  return (
    <PageFrame
      title="Runners"
      current="runners"
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
          {waiting.length > 0 && <PendingList pending={waiting} selected={shownPending?.id} onSelect={setPicked} />}
          {runners === undefined && !error && <p className="empty runners-none">{LOADING}</p>}
          {runners === null && <p className="empty runners-none">This service keeps no runners.</p>}
          <RunnersList runners={runners} error={error} selected={shown?.id} onSelect={setPicked} />
        </>
      }
      main={
        shownPending ? (
          <PendingDetail key={shownPending.id} p={shownPending} actions={actions} onDone={after} />
        ) : shown ? (
          <RunnerDetail
            key={shown.id}
            r={shown}
            actions={actions}
            onDone={after}
            workspaces={
              workspaces && { rows: wsOf(shown), error: ws.error, folders, close: workspaces.close, closing: ws.closing, onClosing: ws.onClosing }
            }
          />
        ) : (
          <ColHead title="No runners yet" />
        )
      }
      side={<Queue queue={queue} />}
    />
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
          className={`prow pick runner pending${on ? ' on' : ''}`}
          data-pending={p.id}
          aria-current={on}
          title={p.id}
          onClick={() => onSelect(p.id)}
        >
          <span className="pr-n">
            <span>
              <i className="rn-dot pending" aria-label={STATE.waiting} />
              {p.name}
            </span>
          </span>
          <span className="pr-m2">
            {STATE.waiting}
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
          This machine ran <code>agentbus login</code>. It takes no work until you approve it. Type the code it shows.
        </p>
        <table className="grid pg-kv">
          <tbody>
            <tr>
              <td>OS</td>
              <td>{p.os ? <span className="rn-chip">{[p.os, p.arch].filter(Boolean).join(' ')}</span> : <span className="dim">not reported</span>}</td>
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
            <Button kind="secondary" className="rn-refuse" disabled={busy} onClick={() => act(() => actions.refuse(p.id))}>
              Refuse
            </Button>{' '}
            <Button kind="primary" type="submit" className="rn-approve-go" disabled={busy || !code.trim()}>
              {busy ? 'Approving…' : 'Approve'}
            </Button>
          </form>
        )}
        {err && <Notice kind="error">{err}</Notice>}
      </div>
    </>
  );
};

// What RunnerDetail shows of the runner's workspaces, from the page's one read.
interface RunnerWorkspaces {
  rows: WorkspaceRow[];
  error: string | null;
  folders?: FolderInfo[];
  close: (workspace: string) => Promise<CloseState>;
  closing: ReadonlySet<string>;
  onClosing: (workspace: string) => void;
}

const RunnerDetail: React.FC<{ r: RunnerInfo; actions?: RunnerActions; onDone: () => void; workspaces?: RunnerWorkspaces }> = ({
  r,
  actions,
  onDone,
  workspaces,
}) => {
  const connector = r.role === 'connector';
  // Remove asks first: its sessions take no more turns after it.
  const [asking, setAsking] = useState(false);
  useEffect(() => setAsking(false), [r.id]);
  const remove = async () => {
    if (!actions) return;
    await actions.remove(r.id);
    onDone();
  };
  const found = r.harnesses.filter((h) => h.found);
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
          <b className={r.online ? 'ok' : 'dim'}>{r.online ? STATE.online : STATE.offline}</b>
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
          <p className="pg-note">
            A connector from before 0.5. It takes no work. Run <code>agentbus runner</code> on this machine instead.
          </p>
        )}
        <table className="grid pg-kv">
          <tbody>
            {!connector && (
              <>
                <tr>
                  <td>Harnesses</td>
                  <td>{chips(found.map((h) => (h.version ? `${harnessName(h.name)} ${h.version}` : harnessName(h.name))), 'none found')}</td>
                </tr>
              </>
            )}
            <tr>
              <td>OS</td>
              <td>{r.os ? chips([[r.os, r.arch].filter(Boolean).join(' ')], '') : <span className="dim">not reported yet</span>}</td>
            </tr>
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
            {r.machine && (
              <tr>
                <td>Machine</td>
                <td>
                  <code>{r.machine}</code>
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
                  <th title={`${PRODUCT} uses the sign-ins in Settings, not this one`}>Local sign-in (not used)</th>
                </tr>
              </thead>
              <tbody>
                {r.harnesses.map((h) => (
                  <tr key={h.name} className={h.found ? '' : 'off'}>
                    <td>{harnessName(h.name)}</td>
                    <td className="t">{h.found ? h.version || '—' : <span className="dim">not found</span>}</td>
                    <td className="dim">{h.found ? (h.signed_in ? 'yes' : 'no') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {workspaces && (
          <>
            {workspaces.error && <Notice kind="error">{workspaces.error}</Notice>}
            <WorkspacesTable rows={workspaces.rows} folders={workspaces.folders} close={workspaces.close} closing={workspaces.closing} onClosing={workspaces.onClosing} />
          </>
        )}
        {actions && !r.online && (
          <p className="rn-remove">
            <Button kind="secondary" className="rn-remove-go" onClick={() => setAsking(true)}>
              Remove
            </Button>{' '}
            <span className="dim">Offline. Remove takes it off this list.</span>
          </p>
        )}
        {asking && (
          <ConfirmDialog
            className="rn-remove-ask"
            title={`Remove ${r.name}?`}
            line="It gets no more work, and its sessions take no more turns. Its record stays."
            action="Remove"
            busyAction="Removing…"
            onConfirm={remove}
            onClose={() => setAsking(false)}
          />
        )}
      </div>
    </>
  );
};

// Queue is the turns still waiting for a runner, and those running now.
const Queue: React.FC<{ queue?: { turns: ApiTurn[]; error: string | null; titleOf?: (session: string) => string | undefined } }> = ({ queue }) => {
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
  // A queue view is built from GET /turns, which carries facts only. It names
  // a turn by its session (its title from GET /sessions where the cockpit has
  // it, else the id) and its agent, never the turn's prompt or reply.
  const what = (t: ApiTurn) => (
    <>
      <span className="rn-prompt">{queue.titleOf?.(t.session) || t.session}</span>
      <div className="note">
        {t.agent ? harnessName(t.agent) : 'agent'}
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
        {queue.error && <Notice kind="error">{queue.error}</Notice>}
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
                  <td className="t">{formatAgo(t.asked) || '—'}</td>
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
                  <td className="t">{formatAgo(t.started) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="f-note first">No turns running.</p>
        )}
      </div>
    </>
  );
};
