import React, { useEffect, useRef, useState } from 'react';
import {
  agentLabel,
  ApiTurn,
  clock,
  defaultModel,
  defaultReviewer,
  ended,
  Finding,
  findingPlace,
  fixPrompt,
  modelHints,
  outcome,
  turnTimes,
} from '../data/jobs';
import { Turn } from '../types';
import { formatCost } from '../utils/format';
import { useNow } from '../utils/useNow';
import { Combo, Select } from './Controls';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Ticks once a second while any of the turns has not ended.
function useQueueClock(turns: ApiTurn[]): number {
  useNow(turns.some((t) => !ended(t)));
  return Date.now();
}

// Whether a turn has ended: its listed row says, else the cockpit's own.
function turnEnded(turn: Turn, row?: ApiTurn): boolean {
  if (row) return ended(row);
  return turn.state !== 'running' && turn.state !== 'queued';
}

// One line for a review: who checked, and what came of it.
function reviewLine(r: ApiTurn, n: number, now: number): React.ReactNode {
  const o = outcome(r);
  const who = agentLabel(r);
  if (!ended(r)) {
    const { ranMs, waitedMs } = turnTimes(r, now);
    const time = r.state === 'queued' ? ` ${clock(waitedMs ?? 0)}` : ranMs !== undefined ? ` ${clock(ranMs)}` : '';
    return (
      <>
        <span className="spin" aria-hidden="true" />
        Review {n} · {who} · <span className="run">{o.label.toLowerCase()}{time}</span>
      </>
    );
  }
  if (r.state === 'finished') {
    const f = r.findings?.length ?? 0;
    return (
      <>
        Checked by {who}:{' '}
        <span className={o.cls}>
          {o.label.toLowerCase()}
          {r.verdict === 'pass' || r.verdict === 'fail' ? `, ${plural(f, 'finding')}` : ''}
        </span>
      </>
    );
  }
  return (
    <>
      Review {n} · {who}: <span className={o.cls}>{o.label.toLowerCase()}</span>
    </>
  );
}

interface ReviewBarProps {
  turn: Turn;
  // The turn's row in the turn list, when the last read had it.
  row?: ApiTurn;
  reviews: ApiTurn[];
  // The agents the framework can run, to pick a reviewer from.
  loadAgents?: () => Promise<{ name: string; found: boolean }[]>;
  onReview: (agent: string, model: string) => Promise<void>;
  onShowTurns: () => void;
  // Puts a prompt in the message box, for the person to edit and send. Given
  // only where the source can send a next message; the box stays disabled
  // while a turn runs.
  onFix?: (prompt: string) => void;
}

// Checked by, the Review button, and the newest review under them (mockup
// v5). Each press asks for a review turn; several may run at once.
export const ReviewBar: React.FC<ReviewBarProps> = ({ turn, row, reviews, loadAgents, onReview, onShowTurns, onFix }) => {
  const [agents, setAgents] = useState<string[]>(['claude', 'codex']);
  const [agent, setAgent] = useState(() => defaultReviewer(turn.agent, ['claude', 'codex']));
  const [model, setModel] = useState(() => defaultModel(defaultReviewer(turn.agent, ['claude', 'codex'])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);
  const now = useQueueClock(reviews);
  const agentRef = useRef(agent);
  agentRef.current = agent;

  useEffect(() => {
    if (!loadAgents) return;
    let active = true;
    loadAgents().then(
      (list) => {
        if (!active) return;
        const names = list.filter((a) => a.found).map((a) => a.name);
        if (names.length === 0) return;
        setAgents(names);
        if (names.includes(agentRef.current)) return;
        const next = defaultReviewer(turn.agent, names);
        setAgent(next);
        setModel(defaultModel(next));
      },
      () => {}
    );
    return () => {
      active = false;
    };
  }, [loadAgents, turn.agent]);

  const canReview = turnEnded(turn, row);
  const press = async () => {
    if (!canReview || busy || !agent) return;
    setBusy(true);
    setError(null);
    try {
      await onReview(agent, model.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const newest = reviews[reviews.length - 1];
  const earlier = reviews.slice(0, -1);
  // Fix is offered on the newest review when it failed: it fills the message
  // box with the findings, and the person sends it as the session's next turn.
  const canFix = !!onFix && !!newest && newest.state === 'finished' && newest.verdict === 'fail';
  return (
    <div className="review-bar">
      <div className="rb-row">
        <label className="rb-pick">
          <span>Checked by</span>
          <span className="rb-fields">
            <Select
              name="reviewer"
              label="Checked by"
              variant="quiet"
              className="rb-agent"
              value={agent}
              options={agents.map((a) => ({ value: a, label: a }))}
              onChange={(v) => {
                setAgent(v);
                setModel(defaultModel(v));
              }}
            />
            <Combo
              name="reviewer-model"
              label="Reviewer model"
              value={model}
              onChange={setModel}
              placeholder="default model"
              suggestions={modelHints(agent)}
            />
          </span>
        </label>
        <button
          type="button"
          className="btn btn-primary rb-go"
          onClick={press}
          disabled={!canReview || busy}
          title={canReview ? undefined : 'Review opens when the turn ends'}
        >
          {busy ? 'Starting…' : 'Review'}
        </button>
      </div>
      {agent === turn.agent && <div className="rb-note warn">Same vendor as the author.</div>}
      {!canReview && <div className="rb-note dim">Review opens when the turn ends.</div>}
      {error && <div className="form-error">{error}</div>}
      {newest && (
        <div className="rb-verdict">
          <span className="rb-line">{reviewLine(newest, reviews.length, now)}</span>
          {canFix && (
            <button
              type="button"
              className="btn btn-secondary btn-sm rb-fix"
              onClick={() => onFix!(fixPrompt(newest.findings ?? [], turn.turnNumber))}
              title="Put the findings in the message box, to edit and send"
            >
              Fix
            </button>
          )}
          <button type="button" className="lnk" onClick={onShowTurns}>
            CI/CD
          </button>
        </div>
      )}
      {earlier.length > 0 && (
        <div className="rb-earlier">
          <button type="button" className="rb-toggle" onClick={() => setShowEarlier((v) => !v)}>
            {showEarlier ? '▾' : '▸'} Earlier reviews ({earlier.length})
          </button>
          {showEarlier &&
            earlier
              .slice()
              .reverse()
              .map((r) => (
                <div key={r.id} className="rb-line dim">
                  {reviewLine(r, reviews.indexOf(r) + 1, now)}
                </div>
              ))}
        </div>
      )}
    </div>
  );
};

// The facts under a turn: how long it waited and ran, what it cost.
const TurnFacts: React.FC<{ row: ApiTurn; now: number }> = ({ row, now }) => {
  const { waitedMs, ranMs } = turnTimes(row, now);
  const facts: React.ReactNode[] = [];
  if (row.state === 'queued') facts.push(row.ahead ? `${plural(row.ahead, 'turn')} ahead` : 'waiting for a runner');
  if (waitedMs !== undefined) facts.push(`waited ${clock(waitedMs)}`);
  if (ranMs !== undefined) facts.push(`ran ${clock(ranMs)}`);
  const cost = formatCost(row.cost_usd);
  if (cost) facts.push(cost);
  if (row.kind === 'review' && ended(row)) facts.push('read-only: no commit');
  return (
    <div className="job-facts">
      {facts.map((f, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="sep">·</span>}
          {f}
        </React.Fragment>
      ))}
    </div>
  );
};

const FindingList: React.FC<{ findings: Finding[] }> = ({ findings }) => (
  <ul className="findings">
    {findings.map((f, i) => (
      <li key={i}>
        <b className={`sev sev-${f.severity.toLowerCase()}`}>{f.severity}</b>
        {findingPlace(f) && <code>{findingPlace(f)}</code>}
        <span>{f.summary}</span>
      </li>
    ))}
  </ul>
);

interface TurnTabProps {
  turn: Turn;
  // The turn's row in the turn list, when the last read had it.
  row?: ApiTurn;
  reviews: ApiTurn[];
  onStop?: (t: ApiTurn) => Promise<void>;
}

// The turn's CI/CD tab: the turn itself, then each review of it, newest
// last, with its state, verdict and findings.
export const TurnTab: React.FC<TurnTabProps> = ({ turn, row, reviews, onStop }) => {
  const now = useQueueClock(row ? [row, ...reviews] : reviews);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const counts = { passed: 0, failed: 0, running: 0 };
  for (const r of reviews) {
    if (!ended(r)) counts.running++;
    else if (r.state === 'finished' && r.verdict === 'pass') counts.passed++;
    else if (r.state === 'finished' && r.verdict === 'fail') counts.failed++;
  }
  const t = row ? outcome(row) : null;
  return (
    <div className="jobs">
      <div className="tab-sum">
        <b>{reviews.length === 0 ? 'No reviews of this turn' : `${plural(reviews.length, 'review')} of this turn`}</b>
        {counts.passed > 0 && (
          <>
            <span className="sep"> · </span>
            <span className="ok">{counts.passed} passed</span>
          </>
        )}
        {counts.failed > 0 && (
          <>
            <span className="sep"> · </span>
            <span className="bad">{counts.failed} failed</span>
          </>
        )}
        {counts.running > 0 && (
          <>
            <span className="sep"> · </span>
            <span className="run">{counts.running} running</span>
          </>
        )}
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className={`job-row turn-job s-${t?.cls ?? ''}`}>
        <div className="job-h">
          <b>The turn</b>
          <code>{turn.id}</code>
          {t && <span className={`job-st ${t.cls}`}>{t.label}</span>}
        </div>
        <div className="job-sub">
          {turn.agentId ?? turn.agent ?? 'session'}
          {turn.model ? ` · ${turn.model}` : ''}
        </div>
        {row && <TurnFacts row={row} now={now} />}
      </div>
      {reviews.map((r, i) => {
        const o = outcome(r);
        const isOpen = open === r.id;
        const reply = r.reply;
        return (
          <div key={r.id} className={`job-row s-${o.cls}`}>
            <div className="job-h">
              {!ended(r) && <span className="spin" aria-hidden="true" />}
              <b>
                Review {i + 1} · Checked by {agentLabel(r)}
              </b>
              <code>{r.id}</code>
              <span className={`job-st ${o.cls}`}>{o.label}</span>
            </div>
            {r.state === 'finished' && (
              <div className="job-sub">
                {r.verdict === 'pass' || r.verdict === 'fail'
                  ? plural(r.findings?.length ?? 0, 'finding')
                  : 'The reply had no verdict block. No verdict is never a pass.'}
              </div>
            )}
            <TurnFacts row={r} now={now} />
            {r.findings && r.findings.length > 0 && <FindingList findings={r.findings} />}
            <div className="job-acts">
              {reply && (
                <button type="button" className="lnk" onClick={() => setOpen(isOpen ? null : r.id)}>
                  {isOpen ? 'Hide the reply' : 'Show the reply'}
                </button>
              )}
              {!ended(r) && onStop && (
                <button
                  type="button"
                  className="lnk"
                  onClick={() => {
                    setError(null);
                    onStop(r).catch((err: Error) => setError(err.message));
                  }}
                >
                  Stop
                </button>
              )}
            </div>
            {isOpen && reply && (
              <pre className="term job-reply">
                {reply}
                {r.reply_truncated ? '…' : ''}
              </pre>
            )}
          </div>
        );
      })}
      <p className="dim job-foot">A review runs read-only on the turn's changes, in a session of its own.</p>
    </div>
  );
};

interface SessionTurnsProps {
  // The session's turns from the turn list, and the reviews of them.
  rows: ApiTurn[];
  turns: Turn[];
  onSelectTurn: (turn: Turn) => void;
  error?: string | null;
}

// The session's turns, live: each turn and review, queued, running or
// ended, with its verdict. A row opens the turn it ran or reviewed.
export const SessionTurns: React.FC<SessionTurnsProps> = ({ rows, turns, onSelectTurn, error }) => {
  const now = useQueueClock(rows);
  const turnOf = (r: ApiTurn): Turn | undefined => turns.find((t) => t.id === (r.kind === 'review' ? r.reviews : r.id));
  return (
    <>
      <div className="sub-h">CI/CD</div>
      {error && <div className="form-error">{error}</div>}
      {rows.length === 0 ? (
        <p className="dim">No turns in this session.</p>
      ) : (
        <div className="grid-scroll">
        <table className="grid events jobs-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Turn</th>
              <th>Agent</th>
              <th>State</th>
              <th className="r">Waited</th>
              <th className="r">Ran</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const turn = turnOf(r);
              const o = outcome(r);
              const { waitedMs, ranMs } = turnTimes(r, now);
              const n = turn?.turnNumber ?? (r.kind === 'review' ? undefined : r.number);
              return (
                <tr key={r.id} className="ev" onClick={() => turn && onSelectTurn(turn)}>
                  <td>
                    {r.kind === 'review' ? 'review' : 'turn'}
                    <div className="note">
                      <code>{r.id}</code>
                    </div>
                  </td>
                  <td>{n ?? '—'}</td>
                  <td>{agentLabel(r)}</td>
                  <td className={o.cls}>
                    {o.label}
                    {r.state === 'queued' && r.ahead ? ` · ${r.ahead} ahead` : ''}
                    {r.kind === 'review' && r.state === 'finished' && (r.verdict === 'pass' || r.verdict === 'fail')
                      ? ` · ${plural(r.findings?.length ?? 0, 'finding')}`
                      : ''}
                  </td>
                  <td className="r">{waitedMs === undefined ? '—' : clock(waitedMs)}</td>
                  <td className="r">{ranMs === undefined ? '—' : clock(ranMs)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
};
