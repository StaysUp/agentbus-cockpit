import React, { useEffect, useRef, useState } from 'react';
import {
  clock,
  defaultModel,
  defaultReviewer,
  ended,
  Finding,
  findingPlace,
  fixPrompt,
  Job,
  jobTimes,
  modelHints,
  outcome,
  reviewerLabel,
  shortRunner,
  currentAttempt,
} from '../data/jobs';
import { Turn } from '../types';
import { formatCost } from '../utils/format';
import { useNow } from '../utils/useNow';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Ticks once a second while any of the jobs has not ended.
function useJobClock(jobs: Job[]): number {
  useNow(jobs.some((j) => !ended(j)));
  return Date.now();
}

// One line for a review: who checked, and what came of it.
function reviewLine(job: Job, n: number, now: number): React.ReactNode {
  const o = outcome(job);
  const who = reviewerLabel(job);
  const at = currentAttempt(job);
  if (!ended(job)) {
    const { ranMs, waitedMs } = jobTimes(job, now);
    const where = at?.runner ? ` on ${shortRunner(at.runner)}` : '';
    const time = job.state === 'queued' ? ` ${clock(waitedMs ?? 0)}` : ranMs !== undefined ? ` ${clock(ranMs)}` : '';
    return (
      <>
        <span className="spin" aria-hidden="true" />
        Review {n} · {who} · <span className="run">{o.label.toLowerCase()}{time}</span>
        {where}
      </>
    );
  }
  if (job.state === 'finished') {
    const f = job.findings?.length ?? 0;
    return (
      <>
        Checked by {who}:{' '}
        <span className={o.cls}>
          {o.label.toLowerCase()}
          {job.verdict === 'unknown' ? '' : `, ${plural(f, 'finding')}`}
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
  // The turn job that ran this turn.
  job: Job;
  reviews: Job[];
  // The agents the framework can run, to pick a reviewer from.
  loadAgents?: () => Promise<{ name: string; found: boolean }[]>;
  onReview: (agent: string, model: string) => Promise<void>;
  onShowJobs: () => void;
  // Puts a prompt in the message box, for the person to edit and send. Given
  // only where the source can send a next message; the box stays disabled
  // while a turn runs.
  onFix?: (prompt: string) => void;
}

// Checked by, the Review button, and the newest review under them (mockup
// v5). Each press makes a review job; several may run at once.
export const ReviewBar: React.FC<ReviewBarProps> = ({ turn, job, reviews, loadAgents, onReview, onShowJobs, onFix }) => {
  const [agents, setAgents] = useState<string[]>(['claude', 'codex']);
  const [agent, setAgent] = useState(() => defaultReviewer(turn.agent, ['claude', 'codex']));
  const [model, setModel] = useState(() => defaultModel(defaultReviewer(turn.agent, ['claude', 'codex'])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);
  const now = useJobClock(reviews);
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

  const canReview = ended(job);
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
            <select
              name="reviewer"
              value={agent}
              onChange={(e) => {
                setAgent(e.target.value);
                setModel(defaultModel(e.target.value));
              }}
            >
              {agents.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <input
              name="reviewer-model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="default model"
              list={`models-${agent}`}
              spellCheck={false}
              autoComplete="off"
            />
            <datalist id={`models-${agent}`}>
              {modelHints(agent).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </span>
        </label>
        <button
          type="button"
          className="rb-go"
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
              className="rb-fix"
              onClick={() => onFix!(fixPrompt(newest.findings ?? [], turn.turnNumber))}
              title="Put the findings in the message box, to edit and send"
            >
              Fix
            </button>
          )}
          <button type="button" className="lnk" onClick={onShowJobs}>
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

// The facts under a job: who, where, how long, what it cost.
const JobFacts: React.FC<{ job: Job; now: number }> = ({ job, now }) => {
  const at = currentAttempt(job);
  const { waitedMs, ranMs } = jobTimes(job, now);
  const facts: React.ReactNode[] = [];
  if (at?.runner) facts.push(<span title={at.runner}>on {shortRunner(at.runner)}</span>);
  else if (job.state === 'queued') facts.push('no runner yet');
  if (at) facts.push(`attempt ${at.number}`);
  if (waitedMs !== undefined) facts.push(`waited ${clock(waitedMs)}`);
  if (ranMs !== undefined) facts.push(`ran ${clock(ranMs)}`);
  const cost = formatCost(job.result?.cost_usd);
  if (cost) facts.push(cost);
  if (job.kind === 'turn' && typeof job.result?.changes?.count === 'number') {
    facts.push(plural(job.result.changes.count, 'file') + ' changed');
  }
  if (job.kind === 'review' && ended(job)) facts.push('read-only: no commit');
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

interface JobsTabProps {
  // The turn job that ran this turn, or undefined for a turn no job ran.
  job?: Job;
  reviews: Job[];
  onCancel?: (job: Job) => Promise<void>;
}

// The turn's CI/CD tab: the turn itself as a job, then each review of it,
// newest last, with its state, runner, verdict and findings.
export const JobsTab: React.FC<JobsTabProps> = ({ job, reviews, onCancel }) => {
  const now = useJobClock(job ? [job, ...reviews] : reviews);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!job) {
    return (
      <p className="dim">
        This turn did not run as a job, so it has no CI/CD jobs. Turns sent while a control plane is connected run as
        jobs, and can be reviewed.
      </p>
    );
  }
  const counts = { passed: 0, failed: 0, running: 0, other: 0 };
  for (const r of reviews) {
    if (!ended(r)) counts.running++;
    else if (r.state === 'finished' && r.verdict === 'pass') counts.passed++;
    else if (r.state === 'finished' && r.verdict === 'fail') counts.failed++;
    else counts.other++;
  }
  const t = outcome(job);
  return (
    <div className="jobs">
      <div className="tab-sum">
        <b>{plural(reviews.length + 1, 'job')} on this turn</b>
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
      <div className={`job-row turn-job s-${t.cls}`}>
        <div className="job-h">
          <b>The turn</b>
          <code>{job.id}</code>
          <span className={`job-st ${t.cls}`}>{t.label}</span>
        </div>
        <div className="job-sub">
          {job.spec.agent ?? 'session'}
          {job.spec.model ? ` · ${job.spec.model}` : ''}
          {job.workspace ? ` · ${job.workspace.kind}` : job.spec.repo ? ' · worktree' : ''}
        </div>
        <JobFacts job={job} now={now} />
      </div>
      {reviews.map((r, i) => {
        const o = outcome(r);
        const isOpen = open === r.id;
        const reply = r.result?.reply_text;
        return (
          <div key={r.id} className={`job-row s-${o.cls}`}>
            <div className="job-h">
              {!ended(r) && <span className="spin" aria-hidden="true" />}
              <b>
                Review {i + 1} · Checked by {reviewerLabel(r)}
              </b>
              <code>{r.id}</code>
              <span className={`job-st ${o.cls}`}>{o.label}</span>
            </div>
            {r.state === 'finished' && (
              <div className="job-sub">
                {r.verdict === 'unknown'
                  ? 'The reply had no verdict block. No verdict is never a pass.'
                  : plural(r.findings?.length ?? 0, 'finding')}
              </div>
            )}
            <JobFacts job={r} now={now} />
            {r.findings && r.findings.length > 0 && <FindingList findings={r.findings} />}
            <div className="job-acts">
              {reply && (
                <button type="button" className="lnk" onClick={() => setOpen(isOpen ? null : r.id)}>
                  {isOpen ? 'Hide the reply' : 'Show the reply'}
                </button>
              )}
              {!ended(r) && onCancel && (
                <button
                  type="button"
                  className="lnk"
                  onClick={() => {
                    setError(null);
                    onCancel(r).catch((err: Error) => setError(err.message));
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
            {isOpen && reply && <pre className="term job-reply">{reply}</pre>}
          </div>
        );
      })}
      <p className="dim job-foot">A review runs read-only in the turn's workspace, in a session of its own.</p>
    </div>
  );
};

interface SessionJobsProps {
  jobs: Job[];
  turns: Turn[];
  // The framework turn a turn job ran, once known.
  refOf: (job: Job) => { session: string; turn: string } | undefined;
  onSelectTurn: (turn: Turn) => void;
  error?: string | null;
}

// The session's jobs, live: each turn and review, its state, runner and
// verdict. A row opens the turn it ran or reviewed.
export const SessionJobs: React.FC<SessionJobsProps> = ({ jobs, turns, refOf, onSelectTurn, error }) => {
  const now = useJobClock(jobs);
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const turnOf = (j: Job): Turn | undefined => {
    const turnJob = j.kind === 'review' ? byId.get(j.links?.reviews_job ?? '') : j;
    const ref = turnJob ? refOf(turnJob) : undefined;
    return ref ? turns.find((t) => t.id === ref.turn) : undefined;
  };
  return (
    <>
      <div className="sub-h">CI/CD</div>
      {error && <div className="form-error">{error}</div>}
      {jobs.length === 0 ? (
        <p className="dim">No jobs in this session.</p>
      ) : (
        <table className="grid events jobs-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Turn</th>
              <th>Agent</th>
              <th>State</th>
              <th>Runner</th>
              <th className="r">Ran</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const turn = turnOf(j);
              const o = outcome(j);
              const { ranMs } = jobTimes(j, now);
              const at = currentAttempt(j);
              return (
                <tr key={j.id} className="ev" onClick={() => turn && onSelectTurn(turn)}>
                  <td>
                    {j.kind}
                    <div className="note">
                      <code>{j.id}</code>
                    </div>
                  </td>
                  <td>{turn ? turn.turnNumber : '—'}</td>
                  <td>{j.kind === 'review' ? reviewerLabel(j) : (j.spec.agent ?? '—')}</td>
                  <td className={o.cls}>
                    {o.label}
                    {j.kind === 'review' && j.state === 'finished' && j.verdict !== 'unknown'
                      ? ` · ${plural(j.findings?.length ?? 0, 'finding')}`
                      : ''}
                  </td>
                  <td title={at?.runner}>{shortRunner(at?.runner) || '—'}</td>
                  <td className="r">{ranMs === undefined ? '—' : clock(ranMs)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
};
