import React, { useEffect, useState } from 'react';
import { turnNotes } from '../data/turns';
import { Level, SessionDetail, Turn } from '../types';
import { formatCost, formatTokens, stateLabel, turnStateClass } from '../utils/format';
import { Cost } from './Cost';

interface ConvoColumnProps {
  session: SessionDetail;
  selectedTurn: Turn | null;
  onSelectTurn: (turn: Turn) => void;
  // The selected level. While the panel is open on a turn or one of its
  // calls, that turn carries the mark; at the session level, and while the
  // panel is closed, nothing here does.
  level?: Level;
  panelOpen?: boolean;
  // The agent's name, for the message box.
  agentName?: string;
  // From the session's row: whether the service takes a next message, and
  // whether a run still holds the session open.
  resumable?: boolean;
  open?: boolean;
  // Given only when the source can continue sessions. Rejects with the API's message.
  onSend?: (prompt: string, readOnly: boolean) => Promise<void>;
  // Given only when the source can stop a turn. Rejects with the API's message.
  onStop?: (turn: Turn) => Promise<void>;
  // The turns the person asked to stop that have not ended yet.
  stopping?: ReadonlySet<string>;
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
  level = 'turn',
  panelOpen = true,
  agentName,
  resumable,
  open,
  onSend,
  onStop,
  stopping,
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
  // While the last turn runs, Send turns into Stop. Only a turn a run started
  // (it names its agent) can be stopped: the service refuses any other. A
  // turn whose reply is in and that only waits for its close keeps
  // "finishing…", unless a stop was already asked for.
  const lastStopping = !!lastTurn && lastState === 'running' && !!stopping?.has(lastTurn.id);
  const showStop = !!onStop && !!lastTurn?.agent && lastState === 'running' && (lastStopping || (pending === null && !finishing));

  const stop = async () => {
    if (!lastTurn || lastStopping) return;
    setSendError(null);
    try {
      await onStop!(lastTurn);
    } catch (err) {
      setSendError((err as Error).message);
    }
  };

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

  // The chat is prompts and replies, under one header line per turn. A turn's
  // calls and how it continued are in the panel, so opening a turn never
  // makes the chat move. An error line is the exception: it stays on its turn.

  return (
    <main id="convo" data-session={session.id}>
      <header id="c-head" className="colhead">
        <div className="colhead-title">{session.title}</div>
      </header>

      <div id="c-msgs">
        <div className="c-in">
          {session.turnsList.map((turn, ti) => {
            const isSelected = selectedTurn?.id === turn.id;
            // The selected turn carries the mark at the turn and call levels.
            const mark = panelOpen && isSelected && level !== 'session' ? 'sel lvl-sel' : '';
            // Calls and the answer come from the turn's events, which are
            // loaded when the turn is opened. Until then the list's row gives
            // the call count, the last call's model and a preview of its reply.
            const detail = turn.detail;
            const calls = detail ? detail.modelCalls.length : turn.modelCalls;
            const lastCall = detail?.modelCalls[detail.modelCalls.length - 1];
            const model = detail ? lastCall?.requested.model : turn.model;
            const answer = detail ? detail.agentResponse : turn.reply;
            const answerCut = !detail && turn.replyTruncated;
            const notes = turnNotes(detail);
            // The turn header's facts: the model that made the turn, then its
            // calls. A line breaks between facts, never inside one.
            const facts = [
              model ? <i className="tb-model">{model}</i> : null,
              calls !== undefined ? <i className="tb-calls">{calls} {calls === 1 ? 'model call' : 'model calls'}</i> : null,
            ].filter((x): x is React.ReactElement => x !== null);

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

                  {/* An error stays on its turn, selected or not. */}
                  {notes.replayErrors.map((msg, i) => (
                    <div key={i} className="form-error turn-error">
                      The earlier turns could not be replayed: {msg}
                    </div>
                  ))}

                  <div className="tb-foot">
                    {(turn.state !== 'finished' || turn.stopped) && (
                      <span className={`tb-state ${turnStateClass(turn)}`}>
                        {turn.state === 'running' && stopping?.has(turn.id) ? 'stopping…' : stateLabel(turn)}
                      </span>
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
          {showStop ? (
            <button type="button" className="go stop" disabled={lastStopping} onClick={stop}>
              {lastStopping ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button type="submit" className="go" disabled={!canSend || draft.trim() === ''}>
              {finishing ? 'finishing…' : 'Send'}
            </button>
          )}
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
