import React, { useEffect, useRef, useState } from 'react';
import { liveStatus, LiveTurn } from '../data/liveStatus';
import { turnNotes } from '../data/turns';
import { Level, SavedAgent, SessionDetail, Turn } from '../types';
import { useNow } from '../utils/useNow';
import { formatCost, formatTokens, stateLabel, turnStateClass } from '../utils/format';
import { Cost } from './Cost';
import { LiveLine } from './LiveLine';

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
  // Given only when the source can continue sessions. Rejects with the API's
  // message. agent is the saved agent picked beside Send, when it is not the
  // agent of the session's latest turn: the turn runs on it.
  onSend?: (prompt: string, readOnly: boolean, agent?: string) => Promise<void>;
  // The saved agents. With onSend, a picker beside Send: any message may go
  // to any of them. Each turn's header names the agent that ran it.
  agents?: SavedAgent[];
  // Given only when the source can stop a turn. Rejects with the API's message.
  onStop?: (turn: Turn) => Promise<void>;
  // The turns the person asked to stop that have not ended yet.
  stopping?: ReadonlySet<string>;
  // Given only by a source that streams: the session's latest turn with its
  // events. A running turn then shows one live status line where its reply
  // will be. Recorded data has none, and its turns show as they are.
  live?: LiveTurn;
  // A prompt to put in the message box, such as Fix's after a failed review.
  // It replaces the draft once, and is then handed back with onPrefillTaken.
  // The person edits it and presses Send; nothing is sent by itself.
  prefill?: { session: string; text: string } | null;
  onPrefillTaken?: () => void;
}

// The harnesses' own names, for a turn no saved agent names.
const HARNESS_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

// The name of the agent that ran a turn: its saved agent's, else its
// harness's. Empty when the turn names none.
export function turnAgentName(turn: Turn, agents?: SavedAgent[]): string {
  const id = turn.agentId ?? turn.agent;
  const saved = id ? agents?.find((a) => a.id === id) : undefined;
  if (saved) return saved.name;
  return turn.agent ? (HARNESS_NAMES[turn.agent] ?? turn.agent) : '';
}

// The saved agent a session's next message goes to by default: the one that
// ran its latest turn. A turn started by harness name alone names the
// harness, which is also the id of that harness's default agent.
export function currentAgent(turns: Turn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.agentId || t.agent) return t.agentId ?? t.agent ?? '';
  }
  return '';
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
  live,
  prefill,
  onPrefillTaken,
  agents,
}) => {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!prefill || prefill.session !== session.id) return;
    setDraft(prefill.text);
    onPrefillTaken?.();
    inputRef.current?.focus();
  }, [prefill, session.id]);
  const [readOnly, setReadOnly] = useState(false);
  // The agent picked beside Send; null follows the session's latest turn.
  const [picked, setPicked] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  // The pending copy goes once a new turn shows up from the stream.
  const turnCount = session.turnsList.length;
  useEffect(() => {
    setPending((p) => (p && turnCount > p.turnsAtSend ? null : p));
  }, [turnCount]);

  // The events a running turn's status is read from: its loaded events, or
  // the stream's copy of the session's latest turn.
  const liveEventsOf = (turn: Turn) =>
    live === undefined || turn.state !== 'running' ? undefined : turn.detail?.events ?? (live?.turn === turn.id ? live.events : undefined);
  const anyRunning = live !== undefined && session.turnsList.some((t) => t.state === 'running');
  const now = useNow(anyRunning);

  const lastTurn = session.turnsList[turnCount - 1];
  const lastState = lastTurn?.state;
  // The reply is in but the service has not stored session.closed yet (it
  // holds the turn open for its last writes). Send waits for that close. With
  // the turn's events, its status says so (a reply beside a tool call is not
  // the last one); without them, any reply counts.
  const lastEvents = lastTurn ? liveEventsOf(lastTurn) : undefined;
  const lastStatus = lastEvents && lastEvents.length > 0 ? liveStatus(lastEvents, now, lastTurn.agent) : undefined;
  const finishing =
    pending === null &&
    lastState === 'running' &&
    (lastStatus ? lastStatus.state !== 'starting' && lastStatus.state !== 'model' && lastStatus.state !== 'tools' && lastStatus.state !== 'agent' : !!(lastTurn?.detail?.agentResponse || lastTurn?.reply));
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

  // The picker: the saved agents, and the session's own agent when it is not
  // one of them (removed since, or a harness with no saved agent).
  const current = currentAgent(session.turnsList);
  const showPick = !!onSend && !!agents && agents.length > 0;
  const pickList = !showPick
    ? []
    : current && !agents!.some((a) => a.id === current)
      ? [{ id: current, name: lastTurn ? turnAgentName(lastTurn, agents) || current : current }, ...agents!]
      : agents!;
  // A pick no longer in the list (its agent was removed) counts as none.
  const pickedShown = picked !== null && pickList.some((a) => a.id === picked) ? picked : null;
  const nextAgent = pickedShown ?? current;
  const nextName = pickList.find((a) => a.id === nextAgent)?.name;
  // Once the session's latest turn ran on the picked agent, or the pick left
  // the list, the pick follows the session again, so a later switch made
  // elsewhere shows here.
  useEffect(() => {
    if (picked !== null && (picked === current || pickedShown === null)) setPicked(null);
  }, [current, picked, pickedShown]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = draft;
    if (!canSend || prompt.trim() === '') return;
    setPending({ prompt, turnsAtSend: turnCount, accepted: false });
    setSendError(null);
    setDraft('');
    try {
      await onSend!(prompt, readOnly, nextAgent && nextAgent !== current ? nextAgent : undefined);
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
            // While the turn runs, one line stands where its reply will be:
            // it never grows. The reply replaces it once the last reply is in.
            const liveEvents = liveEventsOf(turn);
            const status = liveEvents && liveEvents.length > 0 ? liveStatus(liveEvents, now, turn.agent) : undefined;
            const showLive =
              live !== undefined && turn.state === 'running' && !(status && !status.running && answer) && !(status?.state === 'finishing' && answer);
            const replyIn = live !== undefined && turn.state === 'running' && !showLive;
            // The turn header's facts: the agent that ran the turn, the model
            // that made it, then its calls. A line breaks between facts, never
            // inside one.
            const ranBy = turnAgentName(turn, agents);
            const facts = [
              ranBy ? <i className="tb-agent">{ranBy}</i> : null,
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

                  {showLive && (
                    <div className="m-live">
                      {status ? (
                        <LiveLine status={status} />
                      ) : (
                        <span className="live-line run">
                          <i className="spin run-spin" aria-hidden />
                          <span className="live-text">Running</span>
                        </span>
                      )}
                    </div>
                  )}

                  {answer && !showLive && (
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
                    {(turn.state !== 'finished' || turn.stopped) && !(showLive && !stopping?.has(turn.id)) && (
                      <span className={`tb-state ${turnStateClass(turn)}`}>
                        {turn.state === 'running' && stopping?.has(turn.id) ? 'stopping…' : replyIn ? 'finishing' : stateLabel(turn)}
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
        <form className={`box${showPick ? ' with-pick' : ''}`} onSubmit={send}>
          <textarea
            id="input"
            ref={inputRef}
            rows={Math.min(8, draft.split('\n').length)}
            placeholder={`Message ${nextName || agentName || 'the agent'}…`}
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
          {showPick && (
            <select
              className="next-agent"
              aria-label="Agent for the next message"
              title="Agent for the next message"
              value={nextAgent}
              disabled={!canSend}
              onChange={(e) => setPicked(e.target.value)}
            >
              {!nextAgent && <option value="">Agent</option>}
              {pickList.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
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
