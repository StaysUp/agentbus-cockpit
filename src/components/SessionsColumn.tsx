import React, { useEffect, useState } from 'react';
import { liveStatus, LiveTurns } from '../data/liveStatus';
import { sessionAgents } from '../data/turns';
import { SavedAgent, SessionSummary } from '../types';
import { useNow } from '../utils/useNow';
import { formatAgo, formatCost, formatTokens } from '../utils/format';
import { Cost } from './Cost';
import { CopyButton, PlusIcon } from './Icons';
import { LiveLine } from './LiveLine';
import { PencilIcon, TitleEdit } from './TitleEdit';

interface SessionsColumnProps {
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  // Given only when the source can start sessions.
  onNewSession?: () => void;
  // True when the service has no sessions at all.
  empty?: boolean;
  // The latest turn of each session with its events, from the stream. A
  // card whose turn runs shows its live status in place of cost and time.
  live?: LiveTurns;
  // Given when the source can name sessions: a new title for one. Rejects
  // with the API's words.
  onRename?: (sessionId: string, title: string) => Promise<void>;
  // The saved agents, to name the agents that took part in each session.
  agents?: SavedAgent[];
}

export const SessionsColumn: React.FC<SessionsColumnProps> = ({
  sessions,
  selectedSessionId,
  onSelectSession,
  onNewSession,
  empty,
  live,
  onRename,
  agents,
}) => {
  // The session whose name is being edited, if any.
  const [editing, setEditing] = useState<string | null>(null);
  // "3 min ago" moves on with the clock, not only when an event arrives.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGO_TICK_MS);
    return () => clearInterval(id);
  }, []);
  // The status of each session whose latest turn runs. The elapsed times tick
  // each second only while one does.
  const anyRunning = !!live && sessions.some((s) => live[s.id] && liveStatus(live[s.id].events, Date.now()).running);
  const liveNow = useNow(anyRunning);
  const statuses = new Map<string, ReturnType<typeof liveStatus>>();
  if (live) {
    for (const s of sessions) {
      const t = live[s.id];
      if (!t) continue;
      const st = liveStatus(t.events, liveNow, s.agent);
      if (st.running) statuses.set(s.id, st);
    }
  }
  return (
    <section id="sessions">
      <header className="colhead">
        {/* No cost total here, as in the mockup: each card and the panel carry the cost. */}
        <div className="colhead-title">Sessions</div>
        {onNewSession && !empty && (
          <button className="new-session btn btn-quiet" onClick={onNewSession} aria-label="New session" title="New session">
            <PlusIcon />
            Session
          </button>
        )}
      </header>
      <div className="colbody">
        {empty && (
          <div className="empty-state">
            <p className="empty">No sessions yet.</p>
            {onNewSession && (
              <button className="new-session btn btn-quiet" onClick={onNewSession}>
                New session
              </button>
            )}
          </div>
        )}
        {sessions.map((s) => {
          const isSelected = selectedSessionId === s.id;
          const ago = formatAgo(s.last, now);
          const status = statuses.get(s.id);
          // One quiet line: the cost (tokens when no cost is known) and when it
          // was last active.
          const metaTitle = `${s.turns} ${s.turns === 1 ? 'turn' : 'turns'}${s.last ? ` · last active ${new Date(s.last).toLocaleString()}` : ''}`;
          const meta = status ? (
            <span className="s-m s-live" title={metaTitle}>
              <LiveLine status={status} />
            </span>
          ) : (
            <span className="s-m" title={metaTitle}>
              {s.closed ? 'closed · ' : ''}
              {formatCost(s.cost_usd) ? <Cost usd={s.cost_usd} complete={s.cost_complete} /> : `${formatTokens(s.usage)} tokens`}
              {ago ? ` · ${ago}` : ''}
            </span>
          );
          // The agents that took part, from the session's first and latest turns.
          const who = sessionAgents(s, agents);
          const ran = who.length > 0 ? <span className="s-ag">{who.join(', ')}</span> : null;
          const isEditing = editing === s.id && !!onRename;
          // While its turn runs, the cost moves to the title line (as in the sketch).
          // The selected card's name starts a rename when clicked.
          const title = (
            <span className="s-t">
              {s.open ? <i className="live" /> : null}
              {isEditing ? (
                <TitleEdit title={s.title} onSave={(t) => onRename!(s.id, t)} onDone={() => setEditing(null)} />
              ) : isSelected && onRename ? (
                <span className="s-tt s-tt-edit" title="Rename" onClick={() => setEditing(s.id)}>
                  {s.title}
                </span>
              ) : (
                <span className="s-tt">{s.title}</span>
              )}
              {/* A new session's row says $0 before its first reply is priced; show nothing until one is. */}
              {status && formatCost(s.cost_usd) && !(s.cost_usd === 0 && status.costUsd === null) ? (
                <Cost className="s-cost" usd={s.cost_usd} complete={s.cost_complete} />
              ) : null}
            </span>
          );
          // A pencil on hover starts a rename. It sits beside the card, not
          // in it, since a button cannot hold another.
          const pencil =
            onRename && !isEditing ? (
              <button type="button" className="s-rename" aria-label="Rename" title="Rename" onClick={() => setEditing(s.id)}>
                <PencilIcon />
              </button>
            ) : null;
          // The selected card is the session's header: it adds the session id
          // with a copy button. It is not a button, so the copy button can sit
          // in it. A card being renamed is not a button either, so its box can.
          if (isSelected || isEditing) {
            return (
              <div key={s.id} className="sess-row">
                <div className={`sess pick${isSelected ? ' on' : ''}`} data-session={s.id}>
                  {title}
                  {ran}
                  {meta}
                  {isSelected && (
                    <span className="s-id">
                      <code>{s.id}</code>
                      <CopyButton text={s.id} />
                    </span>
                  )}
                </div>
                {pencil}
              </div>
            );
          }
          return (
            <div key={s.id} className="sess-row">
              <button className="sess pick" data-session={s.id} onClick={() => onSelectSession(s.id)}>
                {title}
                {ran}
                {meta}
              </button>
              {pencil}
            </div>
          );
        })}
      </div>
    </section>
  );
};


// How often the last-active times are read again.
export const AGO_TICK_MS = 30_000;
