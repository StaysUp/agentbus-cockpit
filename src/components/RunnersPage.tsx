import React, { useState } from 'react';
import { ApiTurn } from '../data/jobs';
import { RunnerInfo } from '../types';
import { formatAgo } from '../utils/format';
import { ColHead, PageFrame } from './PageFrame';
import { RunnersList, RunnersState } from './RunnersList';

interface RunnersPageProps extends RunnersState {
  onBack: () => void;
  // The turn list, when the service keeps a queue: its queued and running
  // turns make the Queue column. Undefined when it keeps none.
  queue?: { turns: ApiTurn[]; error: string | null };
}

const Sep = () => <span className="sep">·</span>;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The runners page (/runners), in the mockup's three columns: every runner
// and connector control knows; the picked one, with what it reported; and
// the queue.
export const RunnersPage: React.FC<RunnersPageProps> = ({ runners, error, onBack, queue }) => {
  const [picked, setPicked] = useState<string | null>(null);
  const shown = runners?.find((r) => r.id === picked) ?? runners?.[0];
  return (
    <PageFrame
      title="Runners"
      onBack={onBack}
      list={
        <>
          {runners === undefined && !error && <p className="dim runners-none">Reading…</p>}
          {runners === null && <p className="dim runners-none">This service keeps no runners.</p>}
          <RunnersList runners={runners} error={error} selected={shown?.id} onSelect={setPicked} />
        </>
      }
      foot={
        <>
          A runner runs turns. A connector owns the folders on its machine. <code>agentbus up</code> starts one of
          each.
        </>
      }
      main={shown ? <RunnerDetail r={shown} /> : <ColHead title="No runner" />}
      side={<Queue queue={queue} />}
    />
  );
};

const RunnerDetail: React.FC<{ r: RunnerInfo }> = ({ r }) => {
  const connector = r.role === 'connector';
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
        <p className="pg-note">
          {connector
            ? 'Owns the folders on its machine. It takes only their snapshot and apply jobs.'
            : 'Runs turns. It asks control for work, and reports the harnesses it finds.'}
        </p>
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
