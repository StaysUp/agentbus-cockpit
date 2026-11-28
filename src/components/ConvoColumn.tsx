import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { liveStatus, LiveTurn, RUNNER_WAIT_MS, steadyNow } from '../data/liveStatus';
import { harnessName, turnNotes } from '../data/turns';
import { Level, QueuedTurn, SavedAgent, SessionDetail, ShellRun, Started, Turn, TurnDetail, Answer } from '../types';
import { useNow } from '../utils/useNow';
import { FileBase, FileClick, Markdown } from './Markdown';
import { formatCost, formatTokens, stateLabel, turnStateClass } from '../utils/format';
import { Cost } from './Cost';
import { folderLabel, sessionFolderRef, useFolders } from '../data/folders';
import { LiveLine } from './LiveLine';
import { AskedWork, askedLine, askedReview, queuedWaitMs } from '../data/askedWork';
import { PencilIcon, TitleEdit } from './TitleEdit';
import { SessionStatus } from './Icons';
import { CommandLine } from './CommandLine';
import { ApiCommand } from '../data/jobs';
import { ShellEntry } from './ShellEntry';
import { Button, Select } from './Controls';
import { Notice } from './Notice';
import { PRODUCT, SESSION, STATE } from '../words';
import { formatDuration, formatWhen } from '../utils/format';
import { commandsAfter } from '../data/shell';
import { BackButton } from './BackButton';
import { TOO_BIG } from './Changes';
import { endTop, followsEnd, replyStartTop } from '../utils/autoscroll';

interface ConvoColumnProps {
  session: SessionDetail;
  selectedTurn: Turn | null;
  onSelectTurn: (turn: Turn) => void;
  // A click on a local file in a turn's reply. `base` is the session folder
  // the reply's paths were shown relative to. Absent: the click copies the path.
  onOpenFile?: (turn: Turn, base: FileBase, file: FileClick) => void;
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
  onSend?: (prompt: string, agent: string | undefined, key: string) => Promise<Started | undefined | void>;
  // Reads a queued message's turn by its id, so one that ends without
  // starting shows as failed rather than queued for good.
  queuedTurn?: (session: string, turn: string) => Promise<QueuedTurn>;
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
  // The agent the picker shows while the session has no turn yet.
  defaultAgent?: string;
  // Opens the form for a new agent: the picker's "Add an agent first" when
  // no agent is saved.
  onAddAgent?: () => void;
  // The picked agent's sign-in dot, shown beside the picker.
  agentDot?: (agent: SavedAgent) => React.ReactNode;
  // Given only when the source can stop a turn. Rejects with the API's message.
  onStop?: (turn: Turn) => Promise<void>;
  // Stops a queued message's turn before it starts (POST
  // /api/v0/turns/{id}/stop): its Cancel, and its Edit, which then puts the
  // text back in the box to send again. not-running: it started or ended
  // first. Absent: a queued message offers neither.
  onCancelQueued?: (turn: string) => Promise<'stopping' | 'not-running'>;
  // Told which turns are on screen or near it, as the chat scrolls, so their
  // text is read only then.
  onNearTurns?: (turns: string[]) => void;
  // The commands this session's turns handed to AgentBus (run_command): each
  // shows under the turn that asked, or at the foot when that turn is not on
  // screen. onStopCommand: absent, no Stop.
  agentCommands?: ApiCommand[];
  onStopCommand?: (id: string) => Promise<'stopping' | 'not-running'>;
  // The turns the person asked to stop that have not ended yet.
  stopping?: ReadonlySet<string>;
  // Turns whose file changes a Discard dropped: each carries a small
  // "Discarded" mark. The record's own turn.discarded is folded in with this.
  discardedTurns?: ReadonlySet<string>;
  // Given only by a source that streams: the session's latest turn with its
  // events. A running turn then shows one live status line where its reply
  // will be. Recorded data has none, and its turns show as they are.
  live?: LiveTurn;
  // A prompt to put in the message box. It replaces the draft once, and is
  // then handed back with onPrefillTaken. The person edits it and presses
  // Send; nothing is sent by itself. agent, when given, also switches the
  // picker beside Send to that agent (the Review button names a reviewer).
  prefill?: { session: string; text: string; agent?: string } | null;
  onPrefillTaken?: () => void;
  // What the person had typed in this session's box when they last left it,
  // kept by the caller so it outlives a switch to another session and back.
  // onDraftChange hands back each change. Absent: kept here only.
  savedDraft?: string;
  onDraftChange?: (sessionId: string, text: string) => void;
  // The work this session asked another agent for (ask_agent, review_turn)
  // that is queued or running. An asked session is one-off and stays off the
  // sessions list. Each shows one status line at the foot of the
  // conversation, gone when the work ends.
  asked?: AskedWork[];
  // Opens another session: the one asked work runs in, from its running line
  // and from the turn that delivered its result. Without it, no link shows.
  onOpenSession?: (sessionId: string) => void;
  // Given when the source can name sessions: a new title for this one.
  // Rejects with the API's words.
  onRename?: (sessionId: string, title: string) => Promise<void>;
  // While the conversation has work not yet in the person's folder: how many
  // files, and Review, which opens the apply preview in the right panel.
  // tooBig: the copy has too many files to track, so no count and no Review.
  applyBar?: { count: number; onReview: () => void; tooBig?: boolean } | null;
  // approvals, when set, is the commands of this session waiting for a person,
  // shown at the top of the conversation (the ask approvals card).
  approvals?: React.ReactNode;
  // The session's "!" commands from before AgentBus 0.5, oldest first, shown
  // read-only between its turns. A "!" message now goes to the agent like
  // any other: it runs the command with its own shell tool.
  commands?: ShellRun[];
  // Back to the Sessions column, on a narrow screen (src/columns.ts).
  onBack?: () => void;
  // True when the session is archived (hidden from the default list). Only a
  // view: the convo still works and still takes a turn.
  archived?: boolean;
  // Given when the source can archive a session: Archive hides it from the
  // list, Unarchive shows it again. Removes nothing, reversible. 'running'
  // when the session has not finished a turn on this service yet. Rejects
  // with the API's words.
  onArchiveSession?: (sessionId: string, archived: boolean) => Promise<'ok' | 'running'>;
  // Given when the source keeps a record: Export saves the session's events
  // as one .jsonl file. Rejects with the API's words.
  onExport?: (sessionId: string) => Promise<void>;
}

// Why an archive could not be done: the session has no record yet.
export const ARCHIVE_RUNNING = 'This session has not finished a turn yet, so it cannot be archived. Try once a turn has ended.';

// The name of the agent that ran a turn: its saved agent's, else its
// harness's. Empty when the turn names none.
export function turnAgentName(turn: Turn, agents?: SavedAgent[]): string {
  const id = turn.agentId ?? turn.agent;
  const saved = id ? agents?.find((a) => a.id === id) : undefined;
  if (saved) return saved.name;
  return turn.agent ? harnessName(turn.agent) : '';
}

// A turn header's agent and model, each said once. An agent's default name is
// its harness and model ("Codex · deepseek/deepseek-v4.1-flash"), so when the
// name's last part, or the whole name, is the turn's recorded model, the model
// shows once, as its own fact. The name comes back split at " · ", so the
// header can break between its parts.
export function turnHeadFacts(ranBy: string, model?: string): { agent: string[]; model?: string } {
  const agent = ranBy ? ranBy.split(' · ').filter((p) => p !== '') : [];
  if (model && agent.length > 0 && agent[agent.length - 1] === model) agent.pop();
  return { agent, model: model || undefined };
}

// A refusal of a message, for the screen: the agent named by its name, never
// its id, and without the API's pointer to its own routes.
export function refusalText(msg: string, agentId?: string, agentName?: string): string {
  let out = msg;
  if (agentId && agentName) out = out.split(agentId).join(agentName);
  return out.replace(/\s*\((?:GET|POST|PUT|PATCH|DELETE) \/api\/[^)]*\)/g, '').trim();
}

// The name of an agent an origin names: a saved agent's id, else a harness.
export function agentNameOf(id: string | undefined, agents?: SavedAgent[]): string {
  if (!id) return 'an agent';
  return agents?.find((a) => a.id === id)?.name ?? harnessName(id);
}

// A link to another session: the one asked work ran in, or the one that
// asked. Its text is the line it stands in for. Its click opens that session
// only, not the turn it sits in.
const OpenSessionLink: React.FC<{ session: string; onOpen: (id: string) => void; children: React.ReactNode }> = ({
  session,
  onOpen,
  children,
}) => (
  <Button
    kind="link"
    className="origin-link"
    data-session-link={session}
    onClick={(e) => {
      e.stopPropagation();
      onOpen(session);
    }}
  >
    {children}
  </Button>
);

// The line above a turn's message when the person did not type it: a
// delivered result names the agent that did the work, and is a link to the
// session it ran in, which is off the sessions list; an asked turn says so,
// and is a link back to the session that asked.
const OriginLine: React.FC<{ turn: Turn; agents?: SavedAgent[]; onOpenSession?: (id: string) => void }> = ({
  turn,
  agents,
  onOpenSession,
}) => {
  const o = turn.origin;
  if (!o) return null;
  const label =
    o.kind === 'result' ? (
      <>
        {'Result from '}
        <b>{agentNameOf(o.agent, agents)}</b>, sent by {PRODUCT}
      </>
    ) : (
      'Asked by another agent'
    );
  return (
    <div className="m-origin">
      {o.session && onOpenSession ? (
        <OpenSessionLink session={o.session} onOpen={onOpenSession}>
          {label}
        </OpenSessionLink>
      ) : (
        label
      )}
    </div>
  );
};

// True when the page has text selected inside el: the click that ended a drag
// across a reply, say.
export function selectsText(el: Element): boolean {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || sel.toString().trim() === '') return false;
  return (!!sel.anchorNode && el.contains(sel.anchorNode)) || (!!sel.focusNode && el.contains(sel.focusNode));
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
// A message sent and not yet a turn on screen: sending, queued behind the
// session's earlier turns, or accepted and waiting for its turn to show.
export interface Pending {
  key: string;
  prompt: string;
  turnsAtSend: number;
  state: 'sending' | 'queued' | 'accepted' | 'failed';
  ahead?: number;
  // When the service answered queued, on the steady local clock (steadyNow).
  queuedAt?: number;
  // The turn's id, once the service answered.
  turn?: string;
  // Why it failed, in the API's words.
  error?: string;
  // What it was sent with: the agent it named, if any.
  agent?: string;
  // A Cancel or Edit of it while queued is on its way.
  cancelling?: 'cancel' | 'edit';
  // Why a Cancel or Edit did not take, in plain words or the API's.
  cancelError?: string;
}

// An asked session's title is cut to this many characters on its line; the
// whole title is on hover.
const ASKED_TITLE_MAX = 48;
// A title cut to ASKED_TITLE_MAX at a word's end, with an ellipsis.
export function shortTitle(t: string): string {
  if (t.length <= ASKED_TITLE_MAX) return t;
  const cut = t.slice(0, ASKED_TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > ASKED_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// How far off screen a turn's text is read ahead of it, in px.
const NEAR_PX = 800;

// A queued message whose Cancel came after its turn started.
export const TOO_LATE = 'It had already started, so it was not cancelled.';

// An update of a session's pending messages.
export type PendingUpdate = (list: Pending[]) => Pending[];

// How often a queued message's turn is read.
export const QUEUED_POLL_MS = 3000;

// How long a message queued behind nothing waits before it says it waits for
// a runner (see liveStatus).
export { RUNNER_WAIT_MS };

// A key for one message: its turn carries it, so the message is matched to
// the turn that runs it.
export function messageKey(): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `cockpit-msg-${rand}`;
}

// Why a session that is not running takes no next message. Only a session
// no run started (no turn names an agent) came from a terminal. One whose
// only turn failed never started, and says why.
export function cannotContinue(turns: Turn[]): string {
  if (turns.length > 0 && turns.every((t) => !t.agent)) return 'Started in a terminal. Continue it there.';
  if (turns.length === 1 && turns[0].state === 'failed') {
    const err = turns[0].error?.trim().replace(/\.$/, '');
    return `The first turn did not start${err ? `: ${err}` : ''}. Start a new ${SESSION}.`;
  }
  return `This ${SESSION} cannot take another message. Start a new one.`;
}

// A turn's answers before its last: shown above the last, which is turn.reply.
// From the turn's own answers (the single turn's replies), else its events.
function earlierAnswers(turn: Turn, detail: TurnDetail | undefined): Answer[] {
  const all = turn.answers ?? detail?.answers ?? [];
  return all.length > 1 ? all.slice(0, -1) : [];
}

export const ConvoColumn: React.FC<ConvoColumnProps> = ({
  session,
  selectedTurn,
  onSelectTurn,
  onOpenFile,
  level = 'turn',
  panelOpen = true,
  agentName,
  resumable,
  open,
  onSend,
  onStop,
  onCancelQueued,
  onNearTurns,
  agentCommands,
  onStopCommand,
  stopping,
  discardedTurns,
  live,
  prefill,
  onPrefillTaken,
  savedDraft,
  onDraftChange,
  agents,
  onAddAgent,
  agentDot,
  defaultAgent,
  asked,
  onOpenSession,
  queuedTurn,
  keyed,
  pending: keptPending,
  onPending,
  onRename,
  applyBar,
  approvals,
  commands,
  onBack,
  archived,
  onArchiveSession,
  onExport,
}) => {
  // A turn's folder is shown when it is not the session's: by name when the
  // service lists its reference.
  const folders = useFolders();
  const sessionFolder = folderLabel(session.folder, sessionFolderRef(session), folders);
  const turnFolder = (t: Turn) => folderLabel(t.folder, t.folderRef, folders);
  const [draft, setDraft] = useState(savedDraft ?? '');
  useEffect(() => {
    onDraftChange?.(session.id, draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  // The header's name is being edited.
  const [renaming, setRenaming] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  // Archive is only a view and reversible, so it is a direct toggle: no
  // confirmation. 'running' means the session has no record to carry the flag
  // yet, shown inline.
  const doArchive = async () => {
    if (!onArchiveSession || archiving) return;
    setArchiving(true);
    setArchiveError(null);
    try {
      const r = await onArchiveSession(session.id, !archived);
      if (r === 'running') setArchiveError(ARCHIVE_RUNNING);
    } catch (err) {
      setArchiveError((err as Error).message);
    } finally {
      setArchiving(false);
    }
  };
  const doExport = async () => {
    if (!onExport || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      await onExport(session.id);
    } catch (err) {
      setExportError(`Export failed: ${(err as Error).message}`);
    } finally {
      setExporting(false);
    }
  };
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The scroll container of the chat (#c-msgs) and the content inside it
  // (.c-in). The view follows the end of a streaming turn and repositions when
  // it ends; the rules are in utils/autoscroll.
  const msgsRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Whether the view still follows the end. A scroll up by the person turns it
  // off; a scroll back to the end turns it on. The code's own scrolls to the
  // end land at the end, so they keep it on.
  const followRef = useRef(true);
  // Whether the newest message is out of view, so the jump-to-end button shows.
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const readEnd = () => {
    const el = msgsRef.current;
    if (el) setAwayFromEnd(!followsEnd(el));
  };
  // Each turn's block, by turn id, so a turn that just ended can be brought to
  // the top of the view.
  const turnEls = useRef(new Map<string, HTMLDivElement>());
  const scrollToEnd = () => {
    const el = msgsRef.current;
    if (!el) return;
    el.scrollTop = endTop(el);
    setAwayFromEnd(false);
  };
  // Bring a turn's reply to the top of the view, its start first. Falls back to
  // the whole turn block when the reply is not on screen (an error, no reply).
  // The move is instant on purpose: an animation up from the end would, for its
  // first stretch, still read as being at the end, and a content growth caught
  // mid-animation would pin the view back to the bottom.
  const scrollReplyToTop = (turnId: string) => {
    const el = msgsRef.current;
    const turnEl = turnEls.current.get(turnId);
    if (!el || !turnEl) return;
    // The newest answer: a turn that answered more than once has earlier ones above it.
    const replies = turnEl.querySelectorAll<HTMLElement>('.m-agent');
    const reply = replies[replies.length - 1] ?? turnEl;
    const replyTop = el.scrollTop + (reply.getBoundingClientRect().top - el.getBoundingClientRect().top);
    el.scrollTop = replyStartTop(replyTop, el);
  };

  // The person scrolled: follow the end again only once they are back at it.
  const onMsgsScroll = () => {
    const el = msgsRef.current;
    if (!el) return;
    followRef.current = followsEnd(el);
    setAwayFromEnd(!followRef.current);
    // The conversation never scrolls sideways: wide things scroll in their own
    // box. A browser can still shift it (a scrollIntoView, a text selection
    // dragged past the edge), so a sideways offset is put back at once.
    if (el.scrollLeft !== 0) el.scrollLeft = 0;
  };
  // The person asked for the newest message: go there and follow it again.
  const jumpToEnd = () => {
    followRef.current = true;
    scrollToEnd();
  };

  // While a turn runs, the content grows (a live line arrives, a queued message
  // is added, the reply lands); keep the end in view each time, unless the
  // person has scrolled up. It sticks only while a turn runs, so a height change
  // after the turn ended — a reply preview expanding to the full reply when the
  // turn is opened, an image loading — does not pull the view to the bottom.
  useEffect(() => {
    const el = msgsRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (followRef.current && runningNowRef.current !== null) el.scrollTop = endTop(el);
      readEnd();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // Sending scrolls the session to its newest message, the one just sent, and
  // starts following the end again.
  const [sentTick, setSentTick] = useState(0);
  useLayoutEffect(() => {
    if (!sentTick) return;
    followRef.current = true;
    scrollToEnd();
  }, [sentTick]);
  // The follow and reposition transitions, keyed on the newest turn's running
  // state, are further down: that state is read with the turns.

  // The message box grows with its text, wrapped lines too, up to its CSS
  // max-height (about ten lines), and then scrolls inside.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    // A width change rewraps the text.
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [draft]);
  // The agent picked beside Send; null follows the session's latest turn.
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    if (!prefill || prefill.session !== session.id) return;
    setDraft(prefill.text);
    // A Review prefill also names the reviewer: switch the picker to it.
    if (prefill.agent !== undefined) setPicked(prefill.agent);
    onPrefillTaken?.();
    inputRef.current?.focus();
  }, [prefill, session.id]);
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
  const turnIds = session.turnsList.map((t) => t.id).join('\n');
  useEffect(() => {
    const listed = new Set(session.turnsList.map((t) => t.key).filter(Boolean));
    const ids = new Set(session.turnsList.map((t) => t.id));
    setPending((list) => {
      // A message whose own turn is listed goes in any state: a failed copy
      // whose request did get through is not left beside its turn. Its turn is
      // known by its key, or by the id the service answered with.
      const next = list.filter((p) =>
        p.turn && ids.has(p.turn) ? false : keyed ? !listed.has(p.key) : p.state === 'failed' || turnCount <= p.turnsAtSend
      );
      return next.length === list.length ? list : next;
    });
  }, [turnCount, keys, keyed, turnIds]);

  // The events a running turn's status is read from: its loaded events, or
  // the stream's copy of the session's latest turn.
  const liveEventsOf = (turn: Turn) =>
    live === undefined || turn.state !== 'running' ? undefined : turn.detail?.events ?? (live?.turn === turn.id ? live.events : undefined);
  const anyRunning = live !== undefined && session.turnsList.some((t) => t.state === 'running');
  const now = useNow(
    anyRunning || (asked ?? []).length > 0 || pending.some((p) => p.state === 'queued' && !p.ahead)
  );

  const lastTurn = session.turnsList[turnCount - 1];
  const lastState = lastTurn?.state;
  // The reply is in but the service has not stored run.ended yet (it
  // holds the turn open for its last writes). Send waits for that close. With
  // the turn's events, its status says so (a reply beside a tool call is not
  // the last one); without them, any reply counts.
  const lastEvents = lastTurn ? liveEventsOf(lastTurn) : undefined;
  const lastStatus = lastEvents && lastEvents.length > 0 ? liveStatus(lastEvents, now, lastTurn.agent) : undefined;
  const finishing =
    pending.every((p) => p.state === 'failed') &&
    lastState === 'running' &&
    (lastStatus ? lastStatus.state !== 'starting' && lastStatus.state !== 'model' && lastStatus.state !== 'tools' && lastStatus.state !== 'agent' : !!(lastTurn?.detail?.agentResponse || lastTurn?.reply));

  // The scroll is driven by one signal only: the id of the turn that is running,
  // or null. The turn list is authoritative and a turn never returns to running
  // once it ends, so a start and an end are read cleanly from it. Turns run one
  // at a time, so there is at most one; it is found by state, not taken as the
  // last turn, since a queued turn can sit after the running one. The reply
  // text, the live status and whether `live` is set are all deliberately left
  // out — each flickers within a turn (an intermediate call returns text, a tool
  // follows it, the stream resets and repopulates), and reading a scroll off any
  // of them moved the view mid-turn.
  const runningId = session.turnsList.find((t) => t.state === 'running')?.id ?? null;
  const prevRunningRef = useRef<string | null>(runningId);
  // The observer reads this: it follows the end only while a turn runs, so a
  // reply that grows after its turn ended (a preview expanding to the full
  // reply when the turn is opened, an image loading) is never pinned down. The
  // layout effects below keep it in step before any observer callback fires.
  const runningNowRef = useRef<string | null>(runningId);

  // A switch to another session shows its latest message and follows its end.
  useLayoutEffect(() => {
    followRef.current = true;
    scrollToEnd();
    // Adopt the new session's running turn without treating it as a start or an
    // end: the transitions below are within one shown session.
    runningNowRef.current = runningId;
    prevRunningRef.current = runningId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // A turn that starts (Send, a switch to a running session, Ask's Allow)
  // follows its end. A turn that ends brings its reply's start to the top —
  // but only if the person was still at the end; if they had scrolled up to
  // read, they are left where they are. A layout effect, so it runs before the
  // content observer's callback for the same frame.
  useLayoutEffect(() => {
    const prev = prevRunningRef.current;
    if (runningId && runningId !== prev) {
      followRef.current = true;
      scrollToEnd();
    } else if (!runningId && prev && followRef.current) {
      scrollReplyToTop(prev);
    }
    runningNowRef.current = runningId;
    prevRunningRef.current = runningId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningId]);

  // A message sent while a turn runs is queued behind it, so a running turn
  // never blocks Send. Only a session the service cannot continue does.
  const active = pending.filter((p) => p.state !== 'failed').length;
  const turnRunning = active > 0 || lastState === 'running' || !!open;
  const why = !turnRunning && !resumable ? cannotContinue(session.turnsList) : null;
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

  // The picker holds only a saved agent. It starts on the session's last
  // agent; when that one is not saved (removed since, or a harness with no
  // saved agent) it starts empty on "Pick an agent". With no saved agent at
  // all it offers "Add an agent first".
  const current = currentAgent(session.turnsList) || defaultAgent || '';
  const showPick = !!onSend && !!agents;
  const pickList = showPick ? agents! : [];
  // A pick no longer in the list (its agent was removed) counts as none.
  const pickedShown = picked !== null && pickList.some((a) => a.id === picked) ? picked : null;
  const nextAgent = showPick ? (pickedShown ?? (pickList.some((a) => a.id === current) ? current : '')) : current;
  const nextName = pickList.find((a) => a.id === nextAgent)?.name;
  // A message waits for a pick when the session's last agent is not saved,
  // and while no agent is saved at all. A session whose turns name no agent
  // (one a run did not start) still sends with none, and the service picks.
  const needsAgent = showPick && nextAgent === '' && (current !== '' || pickList.length === 0);
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
  // A message always names the agent in the box (it starts as the
  // conversation's last agent), so it runs there whatever runs before it: a
  // conversation keeps no agent of its own (his rule, 2026-11-12). The
  // service reads that agent as it is now; one removed since is refused in
  // the service's words ("pick another"), shown on the message.
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = draft;
    if (!canSend || needsAgent || prompt.trim() === '') return;
    const p: Pending = {
      key: messageKey(),
      prompt,
      turnsAtSend: turnCount,
      state: 'sending',
      agent: nextAgent || undefined,
    };
    setPending((list) => [...list, p]);
    setSendError(null);
    setDraft('');
    setSentTick((n) => n + 1);
    const set = (patch: Partial<Pending>) => setPending((list) => list.map((x) => (x.key === p.key ? { ...x, ...patch } : x)));
    try {
      const started = await onSend!(p.prompt, p.agent, p.key);
      if (started && started.state === 'queued') set({ state: 'queued', ahead: started.ahead, turn: started.turn, queuedAt: steadyNow() });
      else set({ state: 'accepted', turn: started ? started.turn : undefined });
    } catch (err) {
      set({ state: 'failed', error: refusalText((err as Error).message, p.agent, nextName) });
    }
  };
  // A refused message leaves the screen when it is dismissed.
  const dismiss = (p: Pending) => setPending((list) => list.filter((x) => x.key !== p.key));
  // Back to the box: the failed message leaves the list, its text goes
  // after whatever is typed there.
  const takeBack = (p: Pending) => {
    setPending((list) => list.filter((x) => x.key !== p.key));
    setDraft((d) => (d.trim() === '' ? p.prompt : `${d}\n${p.prompt}`));
    inputRef.current?.focus();
  };

  // Cancel or Edit a message still queued: its turn is stopped before it
  // starts. Cancel drops it; Edit then puts its text back in the box, its
  // agent picked, to send again as a new turn. A turn that started first is
  // not stopped: its message stays, and says so.
  const withdraw = async (p: Pending, how: 'cancel' | 'edit') => {
    if (!onCancelQueued || !p.turn || p.cancelling) return;
    const set = (patch: Partial<Pending>) => setPending((list) => list.map((x) => (x.key === p.key ? { ...x, ...patch } : x)));
    set({ cancelling: how, cancelError: undefined });
    try {
      const r = await onCancelQueued(p.turn);
      if (r === 'not-running') {
        set({ cancelling: undefined, cancelError: TOO_LATE });
        return;
      }
      setPending((list) => list.filter((x) => x.key !== p.key));
      if (how === 'edit') {
        if (p.agent) setPicked(p.agent);
        setDraft((d) => (d.trim() === '' ? p.prompt : `${d}\n${p.prompt}`));
        inputRef.current?.focus();
      }
    } catch (err) {
      set({ cancelling: undefined, cancelError: (err as Error).message });
    }
  };

  // A queued message whose turn ends without starting (refused, stopped)
  // shows as failed, with why.
  const sessionId = session.id;
  const waiting = pending.filter((p) => p.state === 'queued' && p.turn).map((p) => p.turn!).join(',');
  useEffect(() => {
    if (!queuedTurn || waiting === '') return;
    let active = true;
    const check = async () => {
      for (const turn of waiting.split(',')) {
        try {
          const st = await queuedTurn(sessionId, turn);
          if (!active) return;
          if (st.ended && st.failed)
            setPending((list) => list.map((x) => (x.turn === turn && x.state === 'queued' ? { ...x, state: 'failed', error: st.why } : x)));
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
  }, [waiting, queuedTurn, sessionId]);

  // The turns on screen or within NEAR_PX of it, told as the chat scrolls.
  // A browser without IntersectionObserver is told every turn.
  const nearRef = useRef(onNearTurns);
  nearRef.current = onNearTurns;
  const turnIdList = session.turnsList.map((t) => t.id).join('\n');
  useEffect(() => {
    if (!nearRef.current || turnIdList === '') return;
    const ids = turnIdList.split('\n');
    if (typeof IntersectionObserver === 'undefined') {
      nearRef.current(ids);
      return;
    }
    const idOf = new Map<Element, string>();
    for (const id of ids) {
      const el = turnEls.current.get(id);
      if (el) idOf.set(el, id);
    }
    const seen = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = idOf.get(e.target);
          if (e.isIntersecting && id) seen.add(id);
        }
        if (seen.size > 0 && !timer)
          timer = setTimeout(() => {
            timer = null;
            const batch = [...seen];
            seen.clear();
            nearRef.current?.(batch);
          }, 50);
      },
      { root: msgsRef.current, rootMargin: `${NEAR_PX}px 0px` }
    );
    for (const el of idOf.keys()) io.observe(el);
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [turnIdList, session.id]);

  // One message not yet a turn. A refused one carries the service's words,
  // Edit (back to the box) and Dismiss.
  const pendingRow = (p: Pending) => (
    <div key={p.key} className={`tb pending${p.state === 'queued' ? ' queued' : ''}${p.state === 'failed' ? ' failed' : ''}`} data-key={p.key}>
      <div className="m-user">
        <div className="bubble prog">{p.prompt}</div>
      </div>
      {p.state === 'failed' ? (
        <div className="tb-foot">
          <Notice kind="error" inline>
            {p.error}
          </Notice>
          <Button kind="link" className="pend-back" onClick={() => takeBack(p)}>
            Edit
          </Button>
          <Button kind="link" className="pend-dismiss" onClick={() => dismiss(p)}>
            Dismiss
          </Button>
        </div>
      ) : (
        <div className="tb-foot">
          <span className="tb-state">
            {p.state === 'sending'
              ? STATE.sending
              : p.state === 'queued'
                ? p.ahead
                  ? `${STATE.queued} · runs after ${p.ahead === 1 ? 'the running turn' : `${p.ahead} turns`}`
                  : p.queuedAt !== undefined && steadyNow() - p.queuedAt < RUNNER_WAIT_MS
                    ? `${STATE.waiting} for the agent`
                    : `${STATE.queued} · waiting for a runner`
                : `${STATE.waiting} for the agent`}
          </span>
          {p.state === 'queued' && p.turn && onCancelQueued && (
            <>
              <Button kind="link" className="pend-edit" disabled={!!p.cancelling} onClick={() => withdraw(p, 'edit')}>
                {p.cancelling === 'edit' ? 'Editing…' : 'Edit'}
              </Button>
              <Button kind="link" className="pend-cancel" disabled={!!p.cancelling} onClick={() => withdraw(p, 'cancel')}>
                {p.cancelling === 'cancel' ? 'Cancelling…' : 'Cancel'}
              </Button>
            </>
          )}
          {p.cancelError && (
            <Notice kind="error" inline>
              {p.cancelError}
            </Notice>
          )}
        </div>
      )}
    </div>
  );
  // A refused message stays where it was sent: after the turns there were
  // then, so it never sits below a later turn. Other messages are last.
  const refusedAfter = (n: number) => pending.filter((p) => p.state === 'failed' && p.turnsAtSend === n && n < turnCount);

  // Each "!" command goes after the turn that started before it.
  const placed = commandsAfter(session.turnsList, commands ?? []);

  // One line per piece of asked work, at the foot of the conversation where
  // the agent's own status shows: queued, then running, gone when it ends.
  // "review" only when the asking turn's tool call was review_turn.
  const askerRunning = session.turnsList.some((t) => t.state === 'running');
  const askedLines = (asked ?? []).map((w) => {
    const by = w.by ? session.turnsList.find((t) => t.id === w.by) : undefined;
    const events = by ? by.detail?.events ?? (live?.turn === by.id ? live.events : undefined) : undefined;
    const waited = w.state === 'queued' ? queuedWaitMs(w.id) : undefined;
    return { w, line: askedLine(w, agentNameOf(w.agent, agents), !!w.review || askedReview(events, w.id), askerRunning, now, waited) };
  });

  // The chat is prompts and replies, under one header line per turn. A turn's
  // calls and how it continued are in the panel, so opening a turn never
  // makes the chat move. An error line is the exception: it stays on its turn.

  return (
    <main id="convo" data-session={session.id}>
      <header id="c-head" className="colhead">
        {onBack && <BackButton label="Sessions" onClick={onBack} />}
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
            {/* The same status slot as the list card: Sandbox shield, and a
                lock when archived. */}
            <SessionStatus sandbox={!!session.sandbox} lock={archived ? 'Archived' : null} />
            {onRename && (
              <button type="button" className="c-rename" aria-label="Rename" title="Rename" onClick={() => setRenaming(true)}>
                <PencilIcon />
              </button>
            )}
            {(onExport || onArchiveSession) && (
              <div className="c-acts">
                {(exportError || archiveError) && (
                  <span className="c-act-error" role="alert" title={exportError || archiveError || ''}>
                    {exportError || archiveError}
                  </span>
                )}
                {onExport && (
                  <Button
                    kind="link"
                    className="c-export"
                    title={`Save this ${SESSION}'s events as one .jsonl file`}
                    disabled={exporting}
                    onClick={doExport}
                  >
                    {exporting ? 'Exporting…' : 'Export'}
                  </Button>
                )}
                {onArchiveSession && (
                  // Archive hides the session from the list; it removes nothing
                  // and the convo keeps working. Reversible, so a direct toggle.
                  <Button
                    kind="quiet"
                    small
                    className="c-archive"
                    disabled={archiving}
                    title={archived ? `Show this ${SESSION} in the list again` : `Hide this ${SESSION} from the list (nothing is removed)`}
                    onClick={doArchive}
                  >
                    {archived ? 'Unarchive' : 'Archive'}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </header>
      <div id="c-msgs" ref={msgsRef} onScroll={onMsgsScroll}>
        <div className="c-in" ref={contentRef}>
          {placed.get(-1)?.map((r) => <ShellEntry key={r.id} run={r} />)}
          {refusedAfter(0).map(pendingRow)}
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
            // turn.reply is the one source of the turn's text: App fills it
            // from the single turn (its whole reply) first, then the events,
            // then the list. Opening the turn must not fall back to the events'
            // partial text over the single turn's whole reply.
            const answer = turn.reply;
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
            // that made it (once, see turnHeadFacts), then its calls. A line
            // breaks between facts and between the parts of the agent's name,
            // never inside one.
            const head = turnHeadFacts(turnAgentName(turn, agents), model);
            const facts = [
              head.agent.length > 0 ? (
                <i className="tb-agent">
                  {head.agent.map((part, i) => (
                    <React.Fragment key={i}>
                      {i > 0 && <><span className="sep"> ·</span>{' '}</>}
                      <span className="tb-fact">{part}</span>
                    </React.Fragment>
                  ))}
                </i>
              ) : null,
              head.model ? (
<i className="tb-model">{head.model}</i>
              ) : null,
              calls !== undefined ? <i className="tb-calls">{calls} {calls === 1 ? 'model call' : 'model calls'}</i> : null,
            ].filter((x): x is React.ReactElement => x !== null);

            return (
              <React.Fragment key={turn.id}>
                {ti > 0 && <div className="tsep" />}
                <div
                  className={`tb pick ${mark}`}
                  ref={(el) => {
                    if (el) turnEls.current.set(turn.id, el);
                    else turnEls.current.delete(turn.id);
                  }}
                  onClick={(e) => {
                    // A click that ends a text selection in this turn is the
                    // person copying, not opening the turn. So is the second
                    // or third click of a double or triple click.
                    if (e.detail > 1 || selectsText(e.currentTarget)) return;
                    onSelectTurn(turn);
                  }}
                >
                  <div className="tb-h">
                    <b>Turn {turn.turnNumber}</b>
                    {facts.length > 0 && (
                      <>
                        {' '}
                        <span>
                          {facts.map((x, i) => (
                            <React.Fragment key={i}>
                              {i > 0 && <><span className="sep"> ·</span>{' '}</>}
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
                          <span className="live-text">{STATE.running}</span>
                        </span>
                      )}
                    </div>
                  )}

                  {/* A turn that answered more than once (the agent resumed after
                      its own background command) shows each earlier answer, in
                      order, with when it came; turn.reply is the last one. */}
                  {earlierAnswers(turn, detail).map((a, i) => (
                    <React.Fragment key={i}>
                      <div className="m-agent md-reply earlier">
                        <Markdown text={a.text} files={{ session: session.id, folder: session.folder }} />
                      </div>
                      <div className="tb-foot">
                        <span className="tb-stat">
                          <time dateTime={a.time} title={new Date(a.time).toLocaleString()}>
                            {formatWhen(a.time)}
                          </time>
                        </span>
                      </div>
                    </React.Fragment>
                  ))}

                  {answer && !showLive && (
                    <div className={`m-agent md-reply${detail ? '' : ' preview'}`}>
                      {/* The agent's reply is markdown, shown formatted. The turn panel keeps it raw. */}
                      <Markdown
                        text={answer}
                        cut={answerCut}
                        files={{ session: session.id, folder: session.folder }}
                        onFile={onOpenFile ? (file) => onOpenFile(turn, { session: session.id, folder: session.folder }, file) : undefined}
                      />
                    </div>
                  )}

                  {notes.replayErrors.map((msg, i) => (
                    <Notice key={i} kind="error" className="turn-error">
                      The earlier turns could not be replayed: {msg}
                    </Notice>
                  ))}

                  <div className="tb-foot">
                    {replyIn && !stopping?.has(turn.id) && status?.running && status.state === 'finishing' ? (
                      // The reply is in and the turn waits on something (a
                      // background command, the agent's exit): the same line
                      // the session card shows, in full, with its time.
                      <LiveLine status={status} className="tb-live" />
                    ) : (turn.state !== 'finished' || turn.stopped) && !(showLive && !stopping?.has(turn.id)) && (
                      <span
                        className={`tb-state ${turnStateClass(turn)}`}
                        title={turn.state === 'failed' && turn.error ? turn.error : undefined}
                      >
                        {turn.state === 'running' && stopping?.has(turn.id) ? STATE.stopping : replyIn ? STATE.finishing : stateLabel(turn)}
                        {turn.state === 'failed' && !turn.stopped && turn.error ? ` · ${turn.error}` : ''}
                      </span>
                    )}
                    {(turn.discarded || discardedTurns?.has(turn.id)) && (
                      <span className="tb-discarded" title="A Discard dropped this turn's changes">
                        Discarded
                      </span>
                    )}
                    <span className="tb-stat">
                      {turnFolder(turn) && turnFolder(turn) !== sessionFolder ? (
                        <>
                          <code className="tb-folder">{turnFolder(turn)}</code> ·{' '}
                        </>
                      ) : null}
                      {formatWhen(turn.endedAt) ? (
                        <>
                          <time dateTime={turn.endedAt} title={new Date(turn.endedAt!).toLocaleString()}>
                            {formatWhen(turn.endedAt)}
                          </time>{' '}
                          ·{' '}
                        </>
                      ) : null}
                      {turn.durationMs !== undefined ? `${formatDuration(turn.durationMs)} · ` : ''}
                      {formatTokens(turn.usage)} tokens
                      {formatCost(turn.costUsd) ? (
                        <>
                          {' '}· <Cost usd={turn.costUsd} complete={turn.costComplete} />
                        </>
                      ) : null}
                    </span>
                  </div>
                </div>
                {placed.get(ti)?.map((r) => <ShellEntry key={r.id} run={r} />)}
                {(agentCommands ?? []).filter((c) => c.turn === turn.id).map((c) => (
                  <CommandLine key={c.id} c={c} onStop={onStopCommand} />
                ))}
                {refusedAfter(ti + 1).map(pendingRow)}
              </React.Fragment>
            );
          })}
          {(agentCommands ?? [])
            .filter((c) => !session.turnsList.some((t) => t.id === c.turn))
            .map((c) => (
              <CommandLine key={c.id} c={c} onStop={onStopCommand} />
            ))}
          {pending.filter((p) => !(p.state === 'failed' && p.turnsAtSend < turnCount)).map(pendingRow)}
          {askedLines.map(({ w, line }) => (
            <div key={w.turn ?? w.id} className="m-live m-asked" role="status" data-asked={w.id} data-state={w.state}>
              <span className={`live-line ${w.state === 'running' ? 'run' : 'dim'}`}>
                {w.state === 'running' ? <i className="spin run-spin" aria-hidden /> : null}
                <span className="live-text">
                  {w.title && (
                    <>
                      <span className="asked-title" title={w.title}>
                        {shortTitle(w.title)}
                      </span>
                      <span className="sep"> · </span>
                    </>
                  )}
                  <span className="asked-line">
                    {w.state === 'running' && onOpenSession ? (
                      <OpenSessionLink session={w.id} onOpen={onOpenSession}>
                        {line}
                      </OpenSessionLink>
                    ) : (
                      line
                    )}
                  </span>
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div id="c-reply">
        {awayFromEnd && (
          // A strip as wide as the message box, so the button centres on the
          // box and the messages, not on the whole column.
          <div className="c-jump-at">
            <button type="button" className="icon-btn c-jump" onClick={jumpToEnd} aria-label="Scroll to the newest message" title="Scroll to the newest message">
              <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        )}
        {approvals}
        {applyBar?.tooBig ? (
          <div className="apply-bar too-big">
            <span className="ab-dot" aria-hidden="true">
              ●
            </span>
            <span className="ab-text">{TOO_BIG}</span>
          </div>
        ) : applyBar && applyBar.count > 0 && (
          <div className="apply-bar">
            <span className="ab-dot" aria-hidden="true">
              ●
            </span>
            <span className="ab-text">
              {applyBar.count} {applyBar.count === 1 ? 'file' : 'files'} changed, not applied
            </span>
            <Button kind="link" className="ab-review" onClick={applyBar.onReview}>
              Changes ▸
            </Button>
          </div>
        )}
        <form className={`box${showPick ? ' with-pick' : ''}`} onSubmit={send}>
          <textarea
            id="input"
            ref={inputRef}
            rows={1}
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
          <div className="box-row">
            {showPick && pickList.length === 0 && (
              <Button kind="quiet" className="next-agent add-first" onClick={onAddAgent} disabled={!onAddAgent}>
                Add an agent first
              </Button>
            )}
            {showPick && pickList.length > 0 && (
              <span className="next-agent-at">
                {agentDot && nextAgent !== '' && agentDot(pickList.find((a) => a.id === nextAgent)!)}
                <Select
                  name="next_agent"
                  className="next-agent"
                  variant="quiet"
                  label="Agent for the next message"
                  title="Agent for the next message"
                  value={nextAgent}
                  placeholder="Pick an agent"
                  disabled={!canSend}
                  options={pickList.map((a) => ({ value: a.id, label: a.name }))}
                  onChange={setPicked}
                  align="right"
                />
              </span>
            )}
            {showStop ? (
              <button type="button" className="go stop" disabled={lastStopping} onClick={stop}>
                {lastStopping ? 'Stopping…' : 'Stop'}
              </button>
            ) : (
              <button
                type="submit"
                className="go"
                title={sendLabel === 'Queue' ? 'Runs after the running turn' : undefined}
                disabled={!canSend || needsAgent || draft.trim() === ''}
              >
                {sendLabel}
              </button>
            )}
          </div>
        </form>
        {onSend && why && (
          <div className="reply-foot">
            <span className="reply-why">{why}</span>
          </div>
        )}
        {sendError && <Notice kind="error">{sendError}</Notice>}
      </div>
    </main>
  );
};
