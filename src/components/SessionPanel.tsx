import React from 'react';
import { SessionDetail, Turn } from '../types';
import { formatDuration, formatTokens, stateClass, stateLabel } from '../utils/format';
import { Cost } from './Cost';
import { CopyButton } from './Icons';
import { PanelHead } from './PanelHead';

interface SessionPanelProps {
  session: SessionDetail;
  // From the session's row: the service's figure plus streamed calls.
  costUsd?: number | null;
  costComplete?: boolean;
  agentName: string;
  onSelectTurn: (turn: Turn) => void;
  onClose?: () => void;
}

// The session level: what the whole session cost and used, and its turns.
export const SessionPanel: React.FC<SessionPanelProps> = ({ session, costUsd, costComplete, agentName, onSelectTurn, onClose }) => {
  const turns = session.turnsList;
  return (
    <section id="right">
      <PanelHead up={[]} onClose={onClose}>
        Session
        <span className="ch-sub">
          {turns.length} {turns.length === 1 ? 'turn' : 'turns'}
        </span>
      </PanelHead>

      <div id="d-head">
        <div className="strip first">
          <div>
            <span>Cost</span>
            <b>{costUsd === null || costUsd === undefined ? '—' : <Cost usd={costUsd} complete={costComplete} />}</b>
          </div>
          <div>
            <span>Turns</span>
            <b>{turns.length}</b>
          </div>
          <div>
            <span>Tokens</span>
            <b>{formatTokens(session.usage)}</b>
          </div>
          <div>
            <span>Session</span>
            <b>
              {session.id}
              <CopyButton text={session.id} />
            </b>
          </div>
        </div>
        <div className="kvs sess-kvs">
          <span>Agent</span>
          <span>{agentName}</span>
          <span>Folder</span>
          <span>{session.folder ? <code>{session.folder}</code> : <span className="dim">not known</span>}</span>
        </div>
      </div>

      <div id="d-body">
        <div className="sub-h first">Turns</div>
        <table className="grid events turns">
          <thead>
            <tr>
              <th>#</th>
              <th>Prompt</th>
              <th className="r">Time</th>
              <th className="r">Cost</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {turns.map((t) => (
              <tr key={t.id} className="ev" onClick={() => onSelectTurn(t)}>
                <td>{t.turnNumber}</td>
                <td>{t.prompt.length > 80 ? `${t.prompt.slice(0, 80)}…` : t.prompt}</td>
                <td className="r">{formatDuration(t.durationMs)}</td>
                <td className="r">
                  <Cost usd={t.costUsd} complete={t.costComplete} />
                </td>
                <td className={stateClass(t.state)}>{stateLabel(t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
