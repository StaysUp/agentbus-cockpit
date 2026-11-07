import React from 'react';
import { SessionSummary } from '../types';
import { formatCost, formatTokens } from '../utils/format';
import { Cost } from './Cost';
import { PlusIcon } from './Icons';

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
          return (
            <button
              key={s.id}
              className={`sess ${isSelected ? 'on' : ''}`}
              onClick={() => onSelectSession(s.id)}
            >
              <span className="s-t">
                {s.open ? <i className="live" /> : null}
                {s.title}
              </span>
              <span className="s-m">
                {formatTokens(s.usage)} tokens ·{' '}
                {formatCost(s.cost_usd) ? (
                  <>
                    <Cost usd={s.cost_usd} complete={s.cost_complete} />
                    {' · '}
                  </>
                ) : null}
                {s.turns} {s.turns === 1 ? 'turn' : 'turns'}
              </span>
              <span className="s-from">
                <code>{s.id}</code>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
};

// The cost of every listed session. Complete only if every session's is known
// and complete. null when no session has a cost.
export function sessionsTotal(sessions: SessionSummary[]): { usd: number; complete: boolean } | null {
  let usd: number | null = null;
  let complete = true;
  for (const s of sessions) {
    if (typeof s.cost_usd === 'number') usd = (usd ?? 0) + s.cost_usd;
    if (typeof s.cost_usd !== 'number' || s.cost_complete !== true) complete = false;
  }
  return usd === null ? null : { usd, complete };
}
