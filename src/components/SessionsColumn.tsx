import React, { useEffect, useState } from 'react';
import { SessionSummary } from '../types';
import { formatAgo, formatCost, formatTokens } from '../utils/format';
import { Cost } from './Cost';
import { CopyButton, PlusIcon } from './Icons';

interface SessionsColumnProps {
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  // Given only when the source can start sessions.
  onNewSession?: () => void;
  // True when the service has no sessions at all.
  empty?: boolean;
}

export const SessionsColumn: React.FC<SessionsColumnProps> = ({
  sessions,
  selectedSessionId,
  onSelectSession,
  onNewSession,
  empty,
}) => {
  const total = sessionsTotal(sessions);
  // "3 min ago" moves on with the clock, not only when an event arrives.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGO_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return (
    <section id="sessions">
      <header className="colhead">
        <div className="colhead-title">
          Sessions
          {total ? (
            <span className="ch-sub">
              <Cost usd={total.usd} complete={total.complete} />
            </span>
          ) : null}
        </div>
        {onNewSession && !empty && (
          <button className="new-session head-btn" onClick={onNewSession} aria-label="New session" title="New session">
            <PlusIcon />
            Session
          </button>
        )}
      </header>
      <div className="colbody">
        {empty && (
          <div className="empty-state">
            <p>No sessions yet.</p>
            {onNewSession && (
              <button className="new-session head-btn" onClick={onNewSession}>
                New session
              </button>
            )}
          </div>
        )}
        {sessions.map((s) => {
          const isSelected = selectedSessionId === s.id;
          const ago = formatAgo(s.last, now);
          // One quiet line: the cost (tokens when no cost is known) and when it
          // was last active.
          const meta = (
            <span className="s-m" title={`${s.turns} ${s.turns === 1 ? 'turn' : 'turns'}${s.last ? ` · last active ${new Date(s.last).toLocaleString()}` : ''}`}>
              {formatCost(s.cost_usd) ? <Cost usd={s.cost_usd} complete={s.cost_complete} /> : `${formatTokens(s.usage)} tokens`}
              {ago ? ` · ${ago}` : ''}
            </span>
          );
          const title = (
            <span className="s-t">
              {s.open ? <i className="live" /> : null}
              {s.title}
            </span>
          );
          // The selected card is the session's header: it adds the session id
          // with a copy button. It is not a button, so the copy button can sit in it.
          if (isSelected) {
            return (
              <div key={s.id} className="sess on" data-session={s.id}>
                {title}
                {meta}
                <span className="s-id">
                  <code>{s.id}</code>
                  <CopyButton text={s.id} />
                </span>
              </div>
            );
          }
          return (
            <button key={s.id} className="sess" data-session={s.id} onClick={() => onSelectSession(s.id)}>
              {title}
              {meta}
            </button>
          );
        })}
      </div>
    </section>
  );
};

// The cost of every listed session. Complete only if every session's is known
// and complete. null when no session has a cost.
// How often the last-active times are read again.
export const AGO_TICK_MS = 30_000;

export function sessionsTotal(sessions: SessionSummary[]): { usd: number; complete: boolean } | null {
  let usd: number | null = null;
  let complete = true;
  for (const s of sessions) {
    if (typeof s.cost_usd === 'number') usd = (usd ?? 0) + s.cost_usd;
    if (typeof s.cost_usd !== 'number' || s.cost_complete !== true) complete = false;
  }
  return usd === null ? null : { usd, complete };
}
