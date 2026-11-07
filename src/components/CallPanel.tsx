import React from 'react';
import { CallGroup, callFailed, turnNotes } from '../data/turns';
import { Level, Turn, TurnDetail } from '../types';
import { formatDuration, formatTime, toolInputSummary } from '../utils/format';
import { ContextTab, LoadContext } from './ContextTab';
import { Cost } from './Cost';
import { PanelHead } from './PanelHead';

export type CallTab = 'reply' | 'sent' | 'context';

interface CallPanelProps {
  turn: Turn;
  call: CallGroup;
  tab: CallTab;
  onTab: (tab: CallTab) => void;
  onLevel?: (level: Level) => void;
  // Opens one of the tool calls in its turn's Events tab.
  onOpenEvent?: (turn: Turn, eventId: string) => void;
  // Reads a call's stored request; left out when the source keeps none.
  loadContext?: LoadContext;
  // The session's turns, to name the turn a replayed history came from.
  turns?: { id: string; turnNumber: number; detail?: TurnDetail }[];
  // Reads one turn's events (of this turn's session), for the Context tab.
  loadTurn?: (sessionId: string, turnId: string) => Promise<TurnDetail | null>;
  onClose?: () => void;
}

const n = (v: number | undefined) => (v ?? 0).toLocaleString();

// The model call level: one request and its reply, from the call's
// model.requested and model.responded pair.
export const CallPanel: React.FC<CallPanelProps> = ({ turn, call, tab, onTab, onLevel, onOpenEvent, loadContext, turns, loadTurn, onClose }) => {
  const req = call.pair.requested;
  const res = call.pair.responded;
  const usage = res?.usage;
  const failed = callFailed(res);
  const notes = turnNotes(turn.detail);
  const prompt = turn.prompt.length > 40 ? `${turn.prompt.slice(0, 40)}…` : turn.prompt;

  return (
    <section id="right">
      <PanelHead
        up={[
          { level: 'session', label: 'Session' },
          { level: 'turn', label: `Turn ${turn.turnNumber}` },
        ]}
        onLevel={onLevel}
        onClose={onClose}
      >
        Call {call.number} of {turn.detail?.modelCalls.length ?? call.number}
        <span className="ch-sub">{prompt}</span>
      </PanelHead>

      <div id="d-head">
        <div className="strip first">
          <div>
            <span>Cost</span>
            <b>{typeof res?.cost_usd === 'number' ? <Cost usd={res.cost_usd} complete={res.cost_complete === true} /> : '—'}</b>
          </div>
          <div>
            <span>Tokens</span>
            <b>{usage ? `${n(usage.input_tokens)} in / ${n(usage.output_tokens)} out` : '—'}</b>
          </div>
          <div>
            <span>Cache</span>
            <b>{usage ? `${n(usage.cache_read_tokens)} read / ${n(usage.cache_write_tokens)} write` : '—'}</b>
          </div>
          <div>
            <span>Latency</span>
            <b>{res?.latency_ms ? formatDuration(res.latency_ms) : '—'}</b>
          </div>
          <div>
            <span>Stop</span>
            <b>
              {failed && <span className="bad">failed</span>}
              {res?.stop_reason ? res.stop_reason : failed ? null : '—'}
            </b>
          </div>
        </div>
      </div>

      <div id="d-tabs">
        <button className={`tab ${tab === 'sent' ? 'on' : ''}`} onClick={() => onTab('sent')}>
          Sent
        </button>
        <button className={`tab ${tab === 'reply' ? 'on' : ''}`} onClick={() => onTab('reply')}>
          Reply
        </button>
        <button className={`tab ${tab === 'context' ? 'on' : ''}`} onClick={() => onTab('context')}>
          Context
        </button>
      </div>

      <div id="d-body">
        {tab === 'reply' && (
          <div>
            {!res ? (
              <p className="dim">No reply yet.</p>
            ) : (
              <>
                {failed && (
                  <div className="kvs">
                    <span>Status</span>
                    <span className={res.status === 200 ? '' : 'bad'}>{res.status ?? 'not reported'}</span>
                    {res.error !== undefined && res.error !== null && res.error !== '' && (
                      <>
                        <span>Error</span>
                        <span className="bad">{typeof res.error === 'string' ? res.error : JSON.stringify(res.error)}</span>
                      </>
                    )}
                  </div>
                )}
                <div className="sub-h first">Text</div>
                {typeof res.text === 'string' && res.text !== '' ? (
                  <div className="reply">
                    {res.text.split('\n\n').map((p, i) => (
                      <p key={i}>{p}</p>
                    ))}
                  </div>
                ) : (
                  <p className="dim">No text.</p>
                )}
              </>
            )}

            <div className="sub-h">Tool calls it asked for</div>
            {call.tools.length === 0 ? (
              <p className="dim">None.</p>
            ) : (
              <table className="grid events asked">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Input</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {call.tools.map((tc) => (
                    <tr key={tc.requested.id} className="ev" onClick={() => onOpenEvent?.(turn, tc.requested.id)}>
                      <td>
                        <code>{tc.requested.tool_name}</code>
                      </td>
                      <td className="sm">
                        <code>{toolInputSummary(tc.requested.tool_input).slice(0, 80)}</code>
                      </td>
                      <td>
                        {tc.completed?.tool_error ? (
                          <span className="bad">error</span>
                        ) : tc.completed ? (
                          <span className="ok">ok</span>
                        ) : (
                          <span className="dim">pending</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'context' && (
          <ContextTab
            exchange={req.exchange}
            load={loadContext}
            replayed={typeof req.replayed === 'number' ? req.replayed : undefined}
            continuity={notes.continuity}
            replayFrom={notes.replayFrom}
            turns={turns}
            loadTurn={loadTurn ? (id) => loadTurn(turn.sessionId, id) : undefined}
            recovered={!!notes.recovered && notes.recovered.turn === notes.replayFrom}
          />
        )}

        {tab === 'sent' && (
          <div className="kvs">
            <span>Model</span>
            <span>{req.model ? <code>{req.model}</code> : <span className="dim">not reported</span>}</span>
            <span>Tools offered</span>
            <span>
              {req.tools_offered ? `${req.tools_offered.length} tools offered` : <span className="dim">not reported</span>}
            </span>
            {req.tools_offered && req.tools_offered.length > 0 && (
              <>
                <span></span>
                <span>{req.tools_offered.join(', ')}</span>
              </>
            )}
            <span>Sent at</span>
            <span>{formatTime(req.time)}</span>
            <span>Event ID</span>
            <span>
              <code>{req.id}</code>
            </span>
            {req.exchange && (
              <>
                <span>Exchange</span>
                <span>
                  <code>{req.exchange}</code>
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
