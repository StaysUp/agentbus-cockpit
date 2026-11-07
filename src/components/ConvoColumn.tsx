import React, { useEffect, useState } from 'react';
import { callFailed, callGroups, continuityLabel, turnNotes } from '../data/turns';
import { Level, SessionDetail, ToolCallPair, Turn } from '../types';
import { formatCost, formatCount, formatDuration, formatTokens, stateClass, toolInputSummary } from '../utils/format';
import { Cost } from './Cost';

interface ConvoColumnProps {
  session: SessionDetail;
  selectedTurn: Turn | null;
  onSelectTurn: (turn: Turn) => void;
  onSelectEvent?: (eventId: string) => void;
  // The selected level and, at the call level, the model.requested id of the
  // call. While the panel is open, a turn or a call carries the mark; at the
  // session level, and while the panel is closed, nothing here does.
  level?: Level;
  panelOpen?: boolean;
  selectedCallId?: string | null;
  // The agent's name, for the message box.
  agentName?: string;
  onSelectCall?: (turn: Turn, callId: string) => void;
  // From the session's row: whether the service takes a next message, and
  // whether a run still holds the session open.
  resumable?: boolean;
  open?: boolean;
  // Given only when the source can continue sessions. Rejects with the API's message.
  onSend?: (prompt: string, readOnly: boolean) => Promise<void>;
}

// The person's message from the moment it is sent until its turn arrives.
interface Pending {
  prompt: string;
  turnsAtSend: number;
  accepted: boolean;
}

export const ConvoColumn: React.FC<ConvoColumnProps> = ({
  session,
  selectedTurn,
  onSelectTurn,
  onSelectEvent,
  level = 'turn',
  panelOpen = true,
  selectedCallId = null,
  agentName,
  onSelectCall,
  resumable,
  open,
  onSend,
}) => {
  const [draft, setDraft] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  // The pending copy goes once a new turn shows up from the stream.
  const turnCount = session.turnsList.length;
  useEffect(() => {
    setPending((p) => (p && turnCount > p.turnsAtSend ? null : p));
  }, [turnCount]);

  const lastTurn = session.turnsList[turnCount - 1];
  const lastState = lastTurn?.state;
  // The reply is on screen but the service has not stored session.closed yet
  // (it holds the turn open for its last writes). Send waits for that close.
  const finishing =
    pending === null && lastState === 'running' && !!(lastTurn?.detail?.agentResponse || lastTurn?.reply);
  const turnRunning = pending !== null || lastState === 'running' || (!!open && !!resumable);
  const why = turnRunning
    ? finishing
      ? 'finishing the last turn'
      : 'a turn is running'
    : !resumable
      ? 'started in a terminal; continue it there'
      : null;
  const canSend = !!onSend && why === null;

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = draft;
    if (!canSend || prompt.trim() === '') return;
    setPending({ prompt, turnsAtSend: turnCount, accepted: false });
    setSendError(null);
    setDraft('');
    try {
      await onSend!(prompt, readOnly);
      setPending((p) => p && { ...p, accepted: true });
    } catch (err) {
      setPending(null);
      setSendError((err as Error).message);
      setDraft(prompt);
    }
  };

  // Only the selected turn shows its working: "Show details", its calls and
  // how it continued. Every other turn shows its prompt and its reply, so the
  // chat reads like a plain chat. A turn is selected while the panel is open
  // on it or on one of its calls; at the session level, or with the panel
  // closed, no turn is.
  const activeTurnId = panelOpen && level !== 'session' ? (selectedTurn?.id ?? null) : null;
  // Whether the selected turn's details are shown. Picking another turn, or
  // closing the panel, hides them again.
  const [expanded, setExpanded] = useState<{ turnId: string; open: boolean } | null>(null);
  useEffect(() => {
    setExpanded(null);
  }, [activeTurnId]);
  const detailsOpen = (turnId: string) => expanded?.turnId === turnId && expanded.open;

  // The selected thing always stays visible: a turn whose call is selected
  // shows its details, and hiding them moves the selection to the turn.
  const holdsSelectedCall = (turn: Turn) =>
    panelOpen && level === 'call' && !!turn.detail?.modelCalls.some((p) => p.requested.id === selectedCallId);
  const toggleTurnDetails = (turn: Turn, shownOpen: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    if (shownOpen && holdsSelectedCall(turn)) onSelectTurn(turn);
    setExpanded({ turnId: turn.id, open: !shownOpen });
  };

  return (
    <main id="convo" data-session={session.id}>
      <header id="c-head" className="colhead">
        <div className="colhead-title">{session.title}</div>
      </header>

      <div id="c-msgs">
        <div className="c-in">
          {session.turnsList.map((turn, ti) => {
            const isSelected = selectedTurn?.id === turn.id;
            // The turn carries the mark at the turn level; at the call level it
            // only holds the marked call.
            const mark = !panelOpen || !isSelected || level === 'session' ? '' : level === 'turn' ? 'sel lvl-sel' : 'holds';
            const isActive = activeTurnId === turn.id;
            const isDetailsOpen = isActive && (detailsOpen(turn.id) || holdsSelectedCall(turn));
            // Calls and the answer come from the turn's events, which are
            // loaded when the turn is opened. Until then the list's row gives
            // the call count, the last call's model and a preview of its reply.
            const detail = turn.detail;
            const hasWork = !!detail && (detail.modelCalls.length > 0 || detail.toolCalls.length > 0);
            const { groups, unmatched } = detail ? callGroups(detail) : { groups: [], unmatched: [] };
            const calls = detail ? detail.modelCalls.length : turn.modelCalls;
            const lastCall = detail?.modelCalls[detail.modelCalls.length - 1];
            const model = detail ? lastCall?.requested.model : turn.model;
            const answer = detail ? detail.agentResponse : turn.reply;
            const answerCut = !detail && turn.replyTruncated;
            const notes = turnNotes(detail);
            const contLabel = isActive ? continuityLabel(notes, session.turnsList) : null;
            // The turn header's facts: the model that made the turn, then its
            // calls. A line breaks between facts, never inside one.
            const facts = [
              model ? <i className="tb-model">{model}</i> : null,
              calls !== undefined ? <i className="tb-calls">{calls} {calls === 1 ? 'model call' : 'model calls'}</i> : null,
              contLabel ? <i className="tb-cont">{contLabel}</i> : null,
            ].filter((x): x is React.ReactElement => x !== null);

            const toolRow = (tc: ToolCallPair) => {
              const evt = tc.requested;
              // Matched by tool_id in the turn's tool calls; no match means pending.
              const comp = tc.completed;
              const hasError = comp?.tool_error;
              return (
                <button
                  key={evt.id}
                  className={`wl tool ${hasError ? 'denied' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectTurn(turn);
                    onSelectEvent?.(evt.id);
                  }}
                >
                  <span className="wk">{evt.tool_name || 'tool'}</span>
                  <span className="wt">
                    <code>{toolInputSummary(evt.tool_input)}</code>
                  </span>
                  <span className="wd">{hasError ? 'error' : comp ? 'ok' : 'pending'}</span>
                </button>
              );
            };

            return (
              <React.Fragment key={turn.id}>
                {ti > 0 && <div className="tsep" />}
                <div className={`tb ${mark}`} onClick={() => onSelectTurn(turn)}>
                  <div className="tb-h">
                    <b>Turn {turn.turnNumber}</b>
                    {facts.length > 0 && (
                      <>
                        {' '}
                        <span>
                          {facts.map((x, i) => (
                            <React.Fragment key={i}>
                              {i > 0 && <span className="sep"> · </span>}
                              {x}
                            </React.Fragment>
                          ))}
                        </span>
                      </>
                    )}
                  </div>
                  <div className="m-user">
                    <div className="bubble">
                      {turn.prompt}
                      {turn.promptTruncated ? '…' : ''}
                    </div>
                  </div>

                  {hasWork && isActive && (
                    <div className="work">
                      <button className="work-h" onClick={(e) => toggleTurnDetails(turn, isDetailsOpen, e)}>
                        {isDetailsOpen ? 'Hide details' : 'Show details'}
                      </button>

                      {isDetailsOpen && (
                        <div className="wlines">
                          {groups.map(({ pair, number, tools }) => {
                            const req = pair.requested;
                            const resp = pair.responded;
                            const on = panelOpen && level === 'call' && selectedCallId === req.id;
                            return (
                              <React.Fragment key={req.id}>
                                <button
                                  className={`wl model ${on ? 'lvl-sel' : ''}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onSelectCall?.(turn, req.id);
                                  }}
                                >
                                  <span className="wk">
                                    call {number} of {calls}
                                  </span>
                                  <span className="wt">
                                    {resp ? (
                                      <>
                                        {formatCount(resp.usage?.input_tokens ?? 0)} in · {formatCount(resp.usage?.output_tokens ?? 0)} out ·{' '}
                                        {callFailed(resp) ? <span className="bad">failed</span> : <code>{resp.stop_reason || 'stop'}</code>}
                                      </>
                                    ) : (
                                      'waiting for the reply'
                                    )}
                                  </span>
                                  <span className="wd">{resp?.latency_ms ? formatDuration(resp.latency_ms) : ''}</span>
                                </button>
                                {tools.map(toolRow)}
                              </React.Fragment>
                            );
                          })}
                          {unmatched.length > 0 && (
                            <div className="wl-unmatched">not matched to a model call</div>
                          )}
                          {unmatched.map(toolRow)}
                        </div>
                      )}
                    </div>
                  )}

                  {answer && (
                    <div className={`m-agent${detail ? '' : ' preview'}`}>
                      {answer.split('\n\n').map((para, i, all) => (
                        <p key={i}>
                          {para}
                          {answerCut && i === all.length - 1 ? '…' : ''}
                        </p>
                      ))}
                    </div>
                  )}

                  {isActive && notes.replayErrors.map((msg, i) => (
                    <div key={i} className="form-error turn-error">
                      The earlier turns could not be replayed: {msg}
                    </div>
                  ))}

                  <div className="tb-foot">
                    {turn.state !== 'finished' && (
                      <span className={`tb-state ${stateClass(turn.state)}`}>{turn.state}</span>
                    )}
                    <span className="tb-stat">
                      {turn.folder && turn.folder !== session.folder ? (
                        <>
                          <code className="tb-folder">{turn.folder}</code> ·{' '}
                        </>
                      ) : null}
                      {turn.durationMs !== undefined ? `${Math.round(turn.durationMs / 1000)}s · ` : ''}
                      {formatTokens(turn.usage)} tokens
                      {formatCost(turn.costUsd) ? (
                        <>
                          {' '}· <Cost usd={turn.costUsd} complete={turn.costComplete} />
                        </>
                      ) : null}
                    </span>
                  </div>
                </div>
              </React.Fragment>
            );
          })}
          {pending && (
            <div className="tb pending">
              <div className="m-user">
                <div className="bubble prog">{pending.prompt}</div>
              </div>
              <div className="tb-foot">
                <span className="tb-state">{pending.accepted ? 'waiting for the agent' : 'sending'}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div id="c-reply">
        <form className="box" onSubmit={send}>
          <textarea
            id="input"
            rows={1}
            placeholder={`Message ${agentName || 'the agent'}…`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            disabled={!canSend}
          />
          <button type="submit" className="go" disabled={!canSend || draft.trim() === ''}>
            {finishing ? 'finishing…' : 'Send'}
          </button>
        </form>
        {onSend && (
          <div className="reply-foot">
            {why ? (
              <span className="reply-why">{why}</span>
            ) : (
              <label className="nd-check">
                <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
                <span>Read only</span>
              </label>
            )}
          </div>
        )}
        {sendError && <div className="form-error">{sendError}</div>}
      </div>
    </main>
  );
};
