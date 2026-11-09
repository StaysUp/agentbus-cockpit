import React, { useEffect, useRef, useState } from 'react';
import { liveStatus, LiveTurn } from '../data/liveStatus';
import { turnNotes } from '../data/turns';
import { Level, QueuedJob, SavedAgent, SessionDetail, Started, Turn } from '../types';
import { useNow } from '../utils/useNow';
import { formatCost, formatTokens, stateLabel, turnStateClass } from '../utils/format';
import { Cost } from './Cost';
import { LiveLine } from './LiveLine';
import { PencilIcon, TitleEdit } from './TitleEdit';

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
  // agent of the session's latest turn: the turn runs on it. key is the
  // message's idempotency_key, which its turn carries. A message sent while
  // a turn runs is queued behind it: the answer says queued.
  onSend?: (prompt: string, readOnly: boolean, agent: string | undefined, key: string) => Promise<Started | undefined | void>;
  // Reads a queued message's turn job, so one that ends without a turn
  // shows as failed rather than queued for good.
  queuedJob?: (job: string) => Promise<QueuedJob>;
  // The source lists each turn's idempotency_key, so a sent message leaves
  // the list only when its own turn is listed. Without it, any newer turn
  // ends a message that is not failed.
  keyed?: boolean;
  // The session's pending messages, kept by the caller so they outlive a
  // switch to another session and back. Absent: kept here.
  pending?: Pending[];
  onPending?: (update: PendingUpdate) => void;
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
  // Opens another session, for the links of a delivered result (to the
  // session that did the work) and of an asked turn (to the session that
  // asked). Without it the links are not shown.
  onOpenSession?: (sessionId: string) => void;
  // Given when the source can name sessions: a new title for this one.
  // Rejects with the API's words.
  onRename?: (sessionId: string, title: string) => Promise<void>;
  // Given when the source keeps each turn's diff: opens a turn's changes.
  onChanges?: (turn: Turn) => void;
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

// The name of an agent an origin names: a saved agent's id, else a harness.
export function agentNameOf(id: string | undefined, agents?: SavedAgent[]): string {
  if (!id) return 'an agent';
  return agents?.find((a) => a.id === id)?.name ?? HARNESS_NAMES[id] ?? id;
}

// The line above a turn's message when the person did not type it: a
// delivered result names the agent that did the work and links to its
// session; an asked turn links to the session that asked.
const OriginLine: React.FC<{ turn: Turn; agents?: SavedAgent[]; onOpenSession?: (id: string) => void }> = ({
  turn,
  agents,
  onOpenSession,
}) => {
  const o = turn.origin;
  if (!o) return null;
  const link = (label: string) =>
    o.session && onOpenSession ? (
      <>
        {' · '}
        <a
          href="#"
          className="origin-link"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpenSession(o.session!);
          }}
        >
          {label}
        </a>
      </>
    ) : null;
  if (o.kind === 'result') {
    return (
      <div className="m-origin">
        {o.jobKind === 'review' ? 'Review result from ' : 'Result from '}
        <b>{agentNameOf(o.agent, agents)}</b>, delivered by AgentBus, not typed by you
        {link('open its session')}
      </div>
    );
  }
  return (
    <div className="m-origin">
      Asked by another agent{link('open the session that asked')}
    </div>
  );
};

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
// A message sent and not yet a turn on screen: sending, queued behind the
// session's earlier turns, or accepted and waiting for its turn to show.
export interface Pending {
  key: string;
  prompt: string;
  turnsAtSend: number;
  state: 'sending' | 'queued' | 'accepted' | 'failed';
  ahead?: number;
  // The turn job, once the service answered.
  job?: string;
  // Why it failed, in the API's words.
  error?: string;
  // What it was sent with: the agent it named, if any.
  readOnly: boolean;
  agent?: string;
}

// An update of a session's pending messages.
export type PendingUpdate = (list: Pending[]) => Pending[];

// How often a queued message's job is read.
export const QUEUED_POLL_MS = 3000;

// A key for one message: its turn carries it, so the message is matched to
// the turn that runs it.
function messageKey(): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `cockpit-msg-${rand}`;
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
  onOpenSession,
  queuedJob,
  keyed,
  pending: keptPending,
  onPending,
  onRename,
  onChanges,
}) => {
  const [draft, setDraft] = useState('');
  // The header's name is being edited.
  const [renaming, setRenaming] = useState(false);
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
  // Messages sent that are not yet turns on screen, oldest first.
  const [localPending, setLocalPending] = useState<Pending[]>([]);
  const pending = keptPending ?? localPending;
  const setPending = onPending ?? setLocalPending;
  const [sendError, setSendError] = useState<string | null>(null);

  // A pending copy goes once its turn is listed: the turn that carries its
  // key, or, from a source that keeps no keys, any turn newer than the send.
  // A failed one stays, with Retry and Edit, until the person acts on it.
  const turnCount = session.turnsList.length;
  const keys = session.turnsList.map((t) => t.key).filter(Boolean).join('\n');
  useEffect(() => {
    const listed = new Set(session.turnsList.map((t) => t.key).filter(Boolean));
    setPending((list) => {
      // A message whose own turn is listed goes in any state: a failed copy
      // whose request did get through is not left beside its turn.
      const next = list.filter((p) => (keyed ? !listed.has(p.key) : p.state === 'failed' || turnCount <= p.turnsAtSend));
      return next.length === list.length ? list : next;
    });
  }, [turnCount, keys, keyed]);

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
    pending.every((p) => p.state === 'failed') &&
    lastState === 'running' &&
    (lastStatus ? lastStatus.state !== 'starting' && lastStatus.state !== 'model' && lastStatus.state !== 'tools' && lastStatus.state !== 'agent' : !!(lastTurn?.detail?.agentResponse || lastTurn?.reply));
  // A message sent while a turn runs is queued behind it, so a running turn
  // never blocks Send. Only a session the service cannot continue does.
  const active = pending.filter((p) => p.state !== 'failed').length;
  const turnRunning = active > 0 || lastState === 'running' || !!open;
  const why = !turnRunning && !resumable ? 'started in a terminal; continue it there' : null;
  const canSend = !!onSend && why === null;
  // While the last turn runs, Send turns into Stop. Only a turn a run started
  // (it names its agent) can be stopped: the service refuses any other. A
  // turn whose reply is in and that only waits for its close keeps
  // "finishing…", unless a stop was already asked for.
  const lastStopping = !!lastTurn && lastState === 'running' && !!stopping?.has(lastTurn.id);
  // While the last turn runs, an empty box shows Stop; typing turns it into
  // Queue, which sends the message to wait behind the running turn.
  const sendLabel = active > 0 || lastState === 'running' ? 'Queue' : 'Send';
  const canStop = !!onStop && !!lastTurn?.agent && lastState === 'running' && (lastStopping || !finishing);
  const showStop = canStop && draft.trim() === '';

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

  // Sends one message. A failed one stays on screen with the API's words
  // and Edit, which puts it back in the box to send anew, so no prompt is
  // lost. There is no automatic retry: a request whose answer was lost may
  // have run, and only the person can tell.
  //
  // A message names the agent picked for it, so it runs there whatever
  // runs before it: a queued switch, or a message that fails. Naming the
  // session's own latest agent keeps the session's model (the service
  // decides when the turn starts). claude and codex are named too: the
  // service takes each as its harness when no saved agent has that id. An
  // agent no longer saved (the session's own, removed since) is not named:
  // the service would refuse it, and the session keeps it.
  const nameable = (id?: string) => !!id && (id === 'claude' || id === 'codex' || !!agents?.some((a) => a.id === id));
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = draft;
    if (!canSend || prompt.trim() === '') return;
    const p: Pending = {
      key: messageKey(),
      prompt,
      turnsAtSend: turnCount,
      state: 'sending',
      readOnly,
      agent: nameable(nextAgent) ? nextAgent : undefined,
    };
    setPending((list) => [...list, p]);
    setSendError(null);
    setDraft('');
    const set = (patch: Partial<Pending>) => setPending((list) => list.map((x) => (x.key === p.key ? { ...x, ...patch } : x)));
    try {
      const started = await onSend!(p.prompt, p.readOnly, p.agent, p.key);
      if (started && started.queued) set({ state: 'queued', ahead: started.ahead, job: started.job });
      else set({ state: 'accepted', job: started ? started.job : undefined });
    } catch (err) {
      set({ state: 'failed', error: (err as Error).message });
    }
  };
  // Back to the box: the failed message leaves the list, its text goes
  // after whatever is typed there.
  const takeBack = (p: Pending) => {
    setPending((list) => list.filter((x) => x.key !== p.key));
    setDraft((d) => (d.trim() === '' ? p.prompt : `${d}\n${p.prompt}`));
    inputRef.current?.focus();
  };

  // A queued message whose job ends without its turn (refused, cancelled)
  // shows as failed, with why.
  const waiting = pending.filter((p) => p.state === 'queued' && p.job).map((p) => p.job!).join(',');
  useEffect(() => {
    if (!queuedJob || waiting === '') return;
    let active = true;
    const check = async () => {
      for (const job of waiting.split(',')) {
        try {
          const st = await queuedJob(job);
          if (!active) return;
          if (st.ended && st.failed)
            setPending((list) => list.map((x) => (x.job === job && x.state === 'queued' ? { ...x, state: 'failed', error: st.why } : x)));
        } catch {
          // A read that fails is tried again on the next tick.
        }
      }
    };
    const id = setInterval(check, QUEUED_POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [waiting, queuedJob]);

  // The chat is prompts and replies, under one header line per turn. A turn's
  // calls and how it continued are in the panel, so opening a turn never
  // makes the chat move. An error line is the exception: it stays on its turn.

  return (
    <main id="convo" data-session={session.id}>
      <header id="c-head" className="colhead">
        {renaming && onRename ? (
          <TitleEdit
            className="c-title-input"
            title={session.title}
            onSave={(t) => onRename(session.id, t)}
            onDone={() => setRenaming(false)}
          />
        ) : (
          <>
            <div
              className={`colhead-title ${onRename ? 'c-title-edit' : ''}`}
              title={onRename ? 'Rename' : undefined}
              onClick={onRename ? () => setRenaming(true) : undefined}
            >
              {session.title}
            </div>
            {onRename && (
              <button type="button" className="c-rename" aria-label="Rename" title="Rename" onClick={() => setRenaming(true)}>
                <PencilIcon />
              </button>
            )}
          </>
        )}
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
                  <OriginLine turn={turn} agents={agents} onOpenSession={onOpenSession} />
                  <div className={`m-user${turn.origin ? ' from-agent' : ''}`}>
                    <div className={`bubble${turn.origin?.kind === 'result' ? ' delivered' : ''}`}>
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
                    {onChanges && turn.state !== 'running' && (
                      <button
                        type="button"
                        className="tb-changes"
                        onClick={(e) => {
                          e.stopPropagation();
                          onChanges(turn);
                        }}
                      >
                        Changes
                      </button>
                    )}
                  </div>
                </div>
              </React.Fragment>
            );
          })}
          {pending.map((p) => (
            <div key={p.key} className={`tb pending${p.state === 'queued' ? ' queued' : ''}${p.state === 'failed' ? ' failed' : ''}`} data-key={p.key}>
              <div className="m-user">
                <div className="bubble prog">{p.prompt}</div>
              </div>
              {p.state === 'failed' && (
                <div className="tb-foot">
                  <span className="form-error">{p.error}</span>
                  <button type="button" className="pend-back" onClick={() => takeBack(p)}>
                    Edit
                  </button>
                </div>
              )}
              {p.state !== 'failed' && (
              <div className="tb-foot">
                <span className="tb-state">
                  {p.state === 'sending'
                    ? 'sending'
                    : p.state === 'queued'
                      ? p.ahead
                        ? `queued · runs after ${p.ahead === 1 ? 'the running turn' : `${p.ahead} turns`}`
                        : 'queued · waiting for a runner'
                      : 'waiting for the agent'}
                </span>
              </div>
              )}
            </div>
          ))}
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
            <span className="go-split">
              <button type="submit" className="go" disabled={!canSend || draft.trim() === ''}>
                {sendLabel}
              </button>
              {/* How to send. Fork (run in parallel from the same point) is
                  shown but not built yet. */}
              <select
                className="send-mode"
                aria-label="How to send"
                title="How to send"
                value="send"
                disabled={!canSend}
                onChange={() => undefined}
              >
                <option value="send">{sendLabel === 'Queue' ? 'Queue: run after the running turn' : 'Send'}</option>
                <option value="fork" disabled>
                  Fork: run in parallel from here (coming soon)
                </option>
              </select>
            </span>
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
