import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import rawSessionsJsonl from '../testdata/sessions-v0.jsonl?raw';
import { AgentsColumn } from './components/AgentsColumn';
import { agentNameOf, ConvoColumn, currentAgent, messageKey, Pending, PendingUpdate } from './components/ConvoColumn';
import { ApprovalsPanel } from './components/ApprovalsPanel';
import { AgentsDialog } from './components/AgentsDialog';
import { SettingsPage } from './components/SettingsPage';
import { AppsPage, AppsApi } from './components/AppsPage';
import { RunnersPage } from './components/RunnersPage';
import { RUNNERS_PAGE_POLL_MS, useRunners } from './components/RunnersList';
import { usePage } from './page';
import { Loading } from './components/Notice';
import { PRODUCT, Session, SESSION, Sessions, SESSIONS } from './words';
import { useColumns } from './columns';
import { BackButton } from './components/BackButton';
import { type SettingsApi } from './data/settings';
import { useTabShown } from './data/useTabShown';
import { SubscriptionApi } from './components/ConnectStep';
import { SignInDot, signInOf } from './components/SignInDot';
import { NewSessionDialog } from './components/NewSessionDialog';
import { ApplyPanel, MERGE_REQUEST, refusedTooBig } from './components/Changes';
import { copyText, fileKey, type FileBase, type FileClick } from './components/Markdown';
import { RightPanel, usePanelTabs } from './components/RightPanel';
import { recordFileName, saveRecord } from './data/exportRecord';
import { SessionsColumn } from './components/SessionsColumn';
import { FolderInfo, FoldersContext, rememberFolder, rememberMachine } from './data/folders';
import { ReplayDataSource } from './data/ReplayDataSource';
import { applyList, countedIn, isNewerList, ListCursor, StreamedCost, streamedCost } from './data/sessionList';
import { addLiveEvent, LiveTurns, mergeLive, noteEventTime, steadyNow } from './data/liveStatus';
import { askedWork } from './data/askedWork';
import { refreshNow } from './utils/useNow';
import { versionLabel } from './utils/format';
import { QueueSource } from './data/jobs';
import { useQueue } from './data/useJobs';
import { useCommands } from './data/commands';
import { addRun } from './data/shell';
import { addStreamedCost, addTurnEvents, createEmptyUsage, turnDetail } from './data/turns';
import {
  ApplyPreview,
  CockpitEvent,
  DataSource,
  EventSelection,
  Level,
  RunRequest,
  SavedAgent,
  SessionDetail,
  SessionList,
  SessionSummary,
  ShellRun,
  Started,
  SubscriptionList,
  Turn,
  TurnDetail,
  VersionInfo,
  TurnText,
} from './types';

// Whether page is a page of its own that the source has the routes for:
// Runners needs the runners route, Settings every settings route. A source
// without them shows the cockpit at that address instead.
function ownPageShown(page: string, d: DataSource): boolean {
  if (page === 'apps') return !!(d.listApps && d.getApp && d.addApp && d.removeApp);
  if (page === 'runners') return !!(d.readRunners || d.listRunners);
  if (page === 'settings') return !!(d.getSettings && d.getPolicy && d.patchPolicy && d.getInstructions && d.putInstructions);
  return false;
}

// No pending messages, the same array each time.
const NO_PENDING: Pending[] = [];
// The texts read when a session's turns are read: its newest turns, which the
// chat opens on. Older ones are read as the chat scrolls near them.
const TEXT_EAGER = 20;
// At most this many turn texts are read at once.
const TEXT_AT_ONCE = 4;
// Runs work over items, at most n at a time.
async function inBatches<T>(items: T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
}
// A session with no first message yet, open in the conversation: its workspace
// is made, and session is set once its first message started one.
interface Draft {
  id: number;
  req: RunRequest;
  title?: string;
  session?: string;
  workspace: string;
}
// The pending list of a draft, before it has a session.
const draftKey = (id: number) => `draft-${id}`;

// The longest wait before the sessions are fetched again after an event.
const LIST_REFRESH_MS = 500;

// How often a running turn of the shown session is read, to see it end.
export const TURN_END_POLL_MS = 2000;

// onSubscription says the turn event e ends ran on a subscription, as its
// turn.started held in live says (access absent means subscription), or
// that nothing held says otherwise.
function onSubscription(live: LiveTurns, e: CockpitEvent): boolean {
  const start = live[e.session]?.turn === e.turn ? live[e.session].events.find((x) => x.kind === 'turn.started') : undefined;
  const access = start?.access;
  return access === undefined || access === 'subscription';
}

// How often the subscriptions are read again, for how much of each plan is
// left (GET /api/v0/subscriptions, usage).
const SUBSCRIPTIONS_EVERY = 60_000;

// Kinds that change a session's summary (agent, folder, open) as the service
// computes it; on these, fetch the sessions again at once.
const SUMMARY_KINDS = new Set(['session.registered', 'run.started', 'run.ended', 'session.renamed', 'events.dropped']);

// Kinds that change a row of GET /api/v0/turns: a new turn, its end, its
// cost and usage, its state, its model calls, model and reply. On these the
// shown session's turns are read again.
const TURN_LIST_KINDS = new Set([
  'turn.started',
  'turn.completed',
  'model.requested',
  'model.responded',
  'run.started',
  'run.ended',
]);

// Kinds that change what applying a conversation would write: a turn ended,
// its changes recorded, or an apply done. On these the preview is read again.
const PREVIEW_KINDS = new Set(['turn.completed', 'turn.changed', 'turn.applied', 'workspace.applied', 'workspace.discarded']);
// A workspace action's end, matched by the workspace it names: these events
// carry no session.
const WORKSPACE_KINDS = new Set(['workspace.applied', 'workspace.discarded', 'workspace.updated', 'workspace.closed', 'workspace.failed']);

// Kinds that change what a turn's Changes or Context tab would read: the turn
// ended by its own completion, or its run closed (a stop or a failure ends
// that way, with no turn.completed); its changes were recorded; or an apply or
// a discard moved them. On these the shown turn's fetching tabs read again.
const TURN_DATA_KINDS = new Set([
  'turn.completed',
  'turn.changed',
  'turn.applied',
  'workspace.applied',
  'workspace.discarded',
  'run.ended',
]);

// Whether a streamed event changes the turn list of `session`.
function changesTurns(event: CockpitEvent, session: string): boolean {
  if (event.kind === 'events.dropped') {
    return event.all_sessions === true || (Array.isArray(event.sessions) && (event.sessions as unknown[]).includes(session));
  }
  return event.session === session && TURN_LIST_KINDS.has(event.kind);
}

// The session on screen: its row as it was when its turns were read, its
// turns, the cursor (store, seq) of that turn list, and the turns whose
// events are loaded, by turn id.
interface Shown {
  session: SessionDetail;
  cursor: ListCursor;
  details: Record<string, TurnDetail>;
  // The whole prompt and reply of each shown turn, loaded from the single
  // turn (getTurnText); the turn list carries no text. Keyed by turn id, it
  // survives a turn-list refresh so a turn's text is read once.
  texts: Record<string, TurnText>;
}

// Add streamed events to the loaded turns they belong to.
function mergeIntoDetails(details: Record<string, TurnDetail>, events: CockpitEvent[]): Record<string, TurnDetail> {
  let out = details;
  for (const e of events) {
    const held = e.turn ? out[e.turn] : undefined;
    if (!held) continue;
    const next = addTurnEvents(held, [e]);
    if (next !== held) out = { ...out, [e.turn!]: next };
  }
  return out;
}

// Bump the data revision of the turns a TURN_DATA_KINDS event changes: the one
// it names, or, for an event that carries no turn (an apply, a discard, or a
// run closing), every turn whose events are loaded. The Changes and Context
// tabs re-read on a bump, so they follow the turn's live events without a timer.
function bumpTurnRev(cur: Record<string, number>, event: CockpitEvent, details: Record<string, TurnDetail>): Record<string, number> {
  const ids = event.turn ? [event.turn] : Object.keys(details);
  if (ids.length === 0) return cur;
  const next = { ...cur };
  for (const id of ids) next[id] = (next[id] ?? 0) + 1;
  return next;
}

function emptyRow(id: string): SessionSummary {
  return { id, agent: '', client: '', title: id, started: '', last: '', open: false, turns: 0, usage: createEmptyUsage() };
}

interface AppProps {
  dataSource?: DataSource;
  // Where the data comes from, shown at the foot of the Agents column.
  sourceLabel?: string;
  onDisconnect?: () => void;
  disconnectLabel?: string;
  // The service's turn queue, when it keeps one: the live turn list that
  // feeds the sessions overview, and stopping a queued or running turn.
  queue?: QueueSource;
}

export const App: React.FC<AppProps> = ({ dataSource: propDataSource, sourceLabel, onDisconnect, disconnectLabel, queue }) => {
  const [dataSource] = useState<DataSource>(
    () => propDataSource || new ReplayDataSource(rawSessionsJsonl)
  );
  // The turn list, read again every few seconds while the service keeps a queue.
  const queueView = useQueue(queue);
  // The commands agents handed to AgentBus, found through their ons.
  const commands = useCommands(queue, queueView?.ons);
  const refreshQueue = queueView?.refresh;
  const refreshQueueRef = useRef(refreshQueue);
  refreshQueueRef.current = refreshQueue;

  // Every session from one snapshot, newest activity first. The Sessions
  // column lists all of them, whatever agent is selected: a session can use
  // many agents. null until the first list arrives.
  const [allSessions, setAllSessions] = useState<SessionSummary[] | null>(null);
  // The saved agent selected in the Agents column: "+ Session" starts on it.
  // It does not filter the sessions. null means nothing is selected.
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // The session on screen, its turns and the turns whose events are loaded.
  // While switching, it stays the previous session until the new one's turns
  // arrive.
  const [shown, setShown] = useState<Shown | null>(null);
  // Each loaded turn's data revision, by turn id: bumped when a streamed event
  // changes what the turn's Changes and Context tabs would read. Those tabs
  // depend on it, so they re-read on the turn's live events.
  const [turnRev, setTurnRev] = useState<Record<string, number>>({});
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  // A selection is an action: the nonce changes on every click, so selecting
  // the same event again still reaches the panel.
  const [selection, setSelection] = useState<EventSelection | null>(null);
  const selectEvent = (id: string | null) => setSelection((s) => ({ id, nonce: (s?.nonce ?? 0) + 1 }));

  // The selected level: the session, a turn (selectedTurnId) or a model call in
  // it (selectedCallId, its model.requested id). It opens on the first turn.
  const [level, setLevel] = useState<Level>('turn');
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  // The right panel starts closed, so the chat has the full width. Only a
  // click on a turn or a call opens it (mockup v3, round 15). Picking an agent
  // or a session leaves it as it is. Its × and Esc close it.
  const [panelOpen, setPanelOpen] = useState(false);
  const panelOpenRef = useRef(false);
  panelOpenRef.current = panelOpen;
  // Set by the turn panel: collapses its open row, if any, and says so.
  const panelEscRef = useRef<(() => boolean) | null>(null);
  // Leaving the turn level drops the event selection, so coming back opens
  // the turn as it was rather than jumping to an old event.
  const selectSessionLevel = () => {
    setLevel('session');
    setSelection(null);
  };
  // One rule for every way a session gets picked (the list, a session the
  // cockpit started, or a pick made because the shown one left the list):
  // the pick selects the session level. Only the first pick on load keeps
  // the default, turn 1. The selected agent stays as it is.
  const chooseSession = (sessionId: string | null) => {
    setSelectedSessionId(sessionId);
    selectSessionLevel();
  };
  const selectTurnLevel = (turn: Turn) => {
    setSelectedTurnId(turn.id);
    setLevel('turn');
  };
  const selectCall = (turn: Turn, callId: string) => {
    setSelectedTurnId(turn.id);
    setSelectedCallId(callId);
    setLevel('call');
    setSelection(null);
  };
  const openEvent = (turn: Turn, eventId: string) => {
    selectTurnLevel(turn);
    selectEvent(eventId);
  };
  // The one click in the chat that opens the panel: a turn.
  const clickTurn = (turn: Turn) => {
    selectTurnLevel(turn);
    setApplyOpen(false);
    columns.forward('turn');
  };
  // Which column a narrow screen shows, and its moves (src/columns.ts).
  const columns = useColumns(panelOpen, setPanelOpen);
  const closePanel = () => columns.back('turn');
  const closePanelRef = useRef(closePanel);
  closePanelRef.current = closePanel;
  // The Agents column is a menu on a narrow screen: open or not.
  const [agentsMenu, setAgentsMenu] = useState(false);
  const agentsMenuRef = useRef(false);
  agentsMenuRef.current = agentsMenu && columns.narrow;


  // The agents form: closed (null), or open for a new agent or on one to edit.
  const [agentsDialog, setAgentsDialog] = useState<{ edit?: SavedAgent } | null>(null);
  // The page on screen: the cockpit, /runners or /settings.
  const [page, goPage] = usePage();
  // The saved agents: the rows of the Agents column, the picker beside Send
  // and each turn's agent name. Read at the start, whenever the agents form
  // closes, after a remove (agentsKey), and on coming back to the cockpit.
  const [savedAgents, setSavedAgents] = useState<SavedAgent[] | undefined>(undefined);
  const [agentsKey, setAgentsKey] = useState(0);
  // The subscriptions control keeps, for each agent's sign-in dot: read
  // with the agents, both again on coming back to the cockpit (Settings is
  // where one is connected or a key set). Undefined before the first read, null when the
  // service keeps none. No polling of its own.
  const [subs, setSubs] = useState<SubscriptionList | null | undefined>(undefined);
  // Reads the subscriptions again now, while the cockpit shows them.
  const readSubsRef = useRef<(() => void) | undefined>(undefined);
  // Settings opens on Subscriptions when an agent's sign-in dot sent it.
  const [settingsAtSubs, setSettingsAtSubs] = useState(false);
  // An agent's name for a screen: a saved agent's, else its harness's.
  const nameOf = (id?: string) => (id ? agentNameOf(id, savedAgents) : undefined);
  // Archive is a view the person toggles: hidden by default, shown with "Show
  // archived". archivedOverride holds what an Archive/Unarchive click just did,
  // so the row reflects it before the list is read again (the service is the
  // source once it does).
  const [showArchived, setShowArchived] = useState(false);
  const [archivedOverride, setArchivedOverride] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const sessions = useMemo(
    () =>
      (allSessions ?? []).map((s) => {
        let row = s;
        const ov = archivedOverride.get(s.id);
        if (ov !== undefined && !!row.archived !== ov) row = { ...row, archived: ov || undefined };
        return row;
      }),
    [allSessions, archivedOverride]
  );
  // The list shows only the sessions the person started. A session an agent
  // asked for (origin kind asked, ask_agent) is reached from the ask inside
  // its asking session (ConvoColumn's origin link opens it), not the top-level
  // list -- a view filter on the recorded origin, nothing dropped: the full
  // sessions set still backs selection, titles and the convo.
  // A session is set aside when archived: hidden from the default list and
  // shown under "Show archived".
  const personSessions = useMemo(
    () => sessions.filter((s) => s.origin?.kind !== 'asked' && (showArchived || !s.archived)),
    [sessions, showArchived]
  );
  // How many of the person's sessions are set aside, so the list offers the
  // "Show archived" toggle only when there is something behind it.
  const archivedCount = useMemo(() => sessions.filter((s) => s.origin?.kind !== 'asked' && s.archived).length, [sessions]);
  // The work a session asked for (ask_agent, review_turn), from the recorded
  // origin and the turn list: queued until a runner starts it, then running.
  // An asked session is one-off and stays off the list; its asking
  // conversation shows one status line for each until its result comes back.
  const askedOf = (sessionId: string) => askedWork(allSessions ?? [], sessionId, queueView?.ofSession, queueView?.ons, queueView?.turnById);
  // The sessions with something under way: their own turn queued or running,
  // or work they asked for. Each gets the running dot on its row.
  const active = useMemo(() => {
    const out = new Set<string>();
    for (const s of allSessions ?? []) {
      if (s.origin?.kind === 'asked') continue;
      const own = queueView?.ofSession(s.id) ?? [];
      if (s.open || own.some((t) => t.state === 'queued' || t.state === 'running') || askedWork(allSessions ?? [], s.id, queueView?.ofSession, queueView?.ons, queueView?.turnById).length > 0) {
        out.add(s.id);
      }
    }
    return out;
  }, [allSessions, queueView]);
  // Each workspace's task: the title of the session (or sessions) whose turns
  // run in it, newest first. The workspace list names no session.
  const taskOfWorkspace = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const s of allSessions ?? []) {
      if (!s.workspace) continue;
      const t = s.title || s.id;
      by.set(s.workspace, [...(by.get(s.workspace) ?? []), t]);
    }
    return (ws: string) => by.get(ws)?.join(', ');
  }, [allSessions]);
  const loading = allSessions === null;
  // A session's title, from the sessions the cockpit holds (GET /sessions).
  // Overview views (the queue) name a turn by this session fact, not by its
  // prompt, which the turn list no longer carries.
  const titleOf = useMemo(() => {
    const byId = new Map((allSessions ?? []).map((s) => [s.id, s.title]));
    return (session: string) => byId.get(session);
  }, [allSessions]);
  // Bumped on each snapshot the stream starts from: read the shown session again.
  const [reloadKey, setReloadKey] = useState(0);
  // Bumped when a session's summary changed: fetch the sessions again.
  const [listKey, setListKey] = useState(0);
  // Bumped on every snapshot the stream starts from; a list read begun before
  // it is older than the stream's cursor and is dropped.
  const snapshotGen = useRef(0);

  const selectedSessionRef = useRef<string | null>(null);
  selectedSessionRef.current = selectedSessionId;
  const selectedTurnRef = useRef<string | null>(null);
  selectedTurnRef.current = selectedTurnId;
  const allSessionsRef = useRef<SessionSummary[] | null>(null);
  allSessionsRef.current = allSessions;
  const shownRef = useRef<Shown | null>(null);
  // Reads the apply preview of a session again (readPreview, below), for the stream.
  const readPreviewRef = useRef<(sessionId: string, fresh?: boolean) => void>(() => {});
  shownRef.current = shown;
  // Events of the selected session that arrive while its turns load.
  const streamedRef = useRef<CockpitEvent[] | null>(null);
  // Events of each turn whose events are loading, by "session/turn".
  const loadingTurnsRef = useRef<Map<string, CockpitEvent[]>>(new Map());
  // The cursor (store, seq) of the list shown, and the streamed calls it does
  // not count yet. A list's row cost is its own figure plus those calls.
  const listCursorRef = useRef<ListCursor | null>(null);
  const costBufferRef = useRef<StreamedCost[]>([]);

  // Show a list. One from the stream's snapshot always wins and starts the
  // buffer over (the stream resends everything after it). A refresh older than
  // the shown list is ignored.
  const takeList = (list: SessionList, fromStream: boolean) => {
    if (fromStream) costBufferRef.current = [];
    else if (!isNewerList(listCursorRef.current, list)) return;
    listCursorRef.current = { store: list.store, seq: list.seq };
    const { sessions, buffer } = applyList(list, costBufferRef.current);
    costBufferRef.current = buffer;
    setAllSessions(sessions);
  };

  // Read the shown session's turns again. At most one read per session is in
  // flight; events that land meanwhile ask for one more read when it returns,
  // so a busy stream costs one read at a time and the last read is never
  // older than the last event. A list replaces the shown one only if it is
  // for the session still shown and not older (by store and seq).
  // Each shown turn's whole prompt and reply, loaded from the single turn
  // (the list carries neither). Kept by session and turn so an ended turn's
  // text is read once; a running turn is read again, as its reply grows. A
  // recorded source has no getTurnText and carries the text on its rows.
  const turnTexts = useRef<Record<string, TurnText>>({});
  //
  // Only the text of a turn on screen, or about to be, is read: the newest
  // TEXT_EAGER turns and every running one when the list is read (the chat
  // opens at its end), and an older turn when the chat scrolls near it
  // (loadNear). At most TEXT_AT_ONCE reads run at once. Every text already
  // cached is used, wherever its turn is.
  const loadTexts = useCallback(
    async (sessionId: string, rows: Turn[], want?: ReadonlySet<string>): Promise<Record<string, TurnText>> => {
      const load = dataSource.getTurnText?.bind(dataSource);
      const cache = turnTexts.current;
      const out: Record<string, TurnText> = {};
      const missing: { id: string; ended: boolean }[] = [];
      const eager = new Set(rows.slice(-TEXT_EAGER).map((t) => t.id));
      for (const t of rows) {
        // A running turn is never read from the cache: its reply is still
        // growing. Only an ended turn's text is final and cacheable.
        const ended = t.state !== 'running';
        const hit = ended ? cache[`${sessionId}\n${t.id}`] : undefined;
        if (hit) out[t.id] = hit;
        else if (load && (want ? want.has(t.id) : eager.has(t.id) || !ended)) missing.push({ id: t.id, ended });
      }
      if (load && missing.length > 0) {
        await inBatches(
          missing,
          TEXT_AT_ONCE,
          async ({ id, ended }) => {
            try {
              const text = await load(sessionId, id);
              out[id] = text;
              // Cache only a turn that had ended when the fetch started, so a
              // running turn's text never poisons the ended-turn cache and the
              // final reply is read once the turn ends.
              if (ended) cache[`${sessionId}\n${id}`] = text;
            } catch (err) {
              console.warn(`Reading turn ${id} text failed:`, err);
            }
          }
        );
      }
      return out;
    },
    [dataSource]
  );
  // The chat scrolled near these turns: read the text of those not read yet,
  // once each, and show it.
  const nearReads = useRef<Set<string>>(new Set());
  const loadNear = useCallback(
    (sessionId: string, ids: string[]) => {
      const s = shownRef.current;
      if (!s || s.session.id !== sessionId) return;
      const want = new Set(ids.filter((id) => !s.texts[id] && !nearReads.current.has(`${sessionId}\n${id}`)));
      if (want.size === 0) return;
      for (const id of want) nearReads.current.add(`${sessionId}\n${id}`);
      const rows = s.session.turnsList.filter((t) => want.has(t.id));
      loadTexts(sessionId, rows, want)
        .then((texts) => setShown((cur) => (cur && cur.session.id === sessionId ? { ...cur, texts: { ...cur.texts, ...texts } } : cur)))
        .finally(() => {
          for (const id of want) nearReads.current.delete(`${sessionId}\n${id}`);
        });
    },
    [loadTexts]
  );

  const turnReads = useRef<Map<string, boolean>>(new Map());
  const refreshTurns = useRef<(sessionId: string) => void>(() => {});
  refreshTurns.current = (sessionId: string) => {
    const reads = turnReads.current;
    if (reads.has(sessionId)) {
      reads.set(sessionId, true);
      return;
    }
    reads.set(sessionId, false);
    dataSource
      .getTurns(sessionId)
      .then(async (list) => {
        const texts = await loadTexts(sessionId, list.turns);
        // A turn settling (running -> finished/failed/stopped) is discovered
        // through several paths -- a streamed event, the end poll, or an
        // events.dropped refresh -- and the job's end has no event of its own.
        // Whichever path re-read the list, bump the revision of each loaded
        // turn whose state changed, here at the one place the list is re-read,
        // so the Changes and Context tabs follow every path and a settled turn
        // is current without each path having to know to bump.
        const prev = shownRef.current;
        if (prev && prev.session.id === sessionId && isNewerList(prev.cursor, list)) {
          const was = new Map(prev.session.turnsList.map((t) => [t.id, t.state]));
          const moved = list.turns.filter((t) => was.has(t.id) && was.get(t.id) !== t.state).map((t) => t.id);
          if (moved.length > 0) {
            setTurnRev((cur) => {
              const next = { ...cur };
              for (const id of moved) next[id] = (next[id] ?? 0) + 1;
              return next;
            });
          }
        }
        setShown((s) =>
          s && s.session.id === sessionId && isNewerList(s.cursor, list)
            ? {
                ...s,
                session: { ...s.session, turnsList: list.turns },
                cursor: { store: list.store, seq: list.seq },
                texts: { ...s.texts, ...texts },
              }
            : s
        );
      })
      .catch((err) => console.warn('Reading the turns again failed:', err))
      .finally(() => {
        const again = reads.get(sessionId);
        reads.delete(sessionId);
        if (again) refreshTurns.current(sessionId);
      });
  };

  // A turn reads running until its job has ended, a moment after its last
  // event (run.ended). No event says the job ended, so the stream never
  // asks for the list again. While the shown session has a running turn,
  // read each such turn alone every TURN_END_POLL_MS, and read the list once
  // one has ended.
  const shownSession = shown?.session.id;
  const runningTurns = shown ? shown.session.turnsList.filter((t) => t.state === 'running').map((t) => t.id).join(',') : '';
  useEffect(() => {
    if (!shownSession || runningTurns === '' || !dataSource.queuedTurn || !dataSource.subscribe) return;
    let active = true;
    let reading = false;
    const check = async () => {
      if (reading) return;
      reading = true;
      try {
        for (const turn of runningTurns.split(',')) {
          const st = await dataSource.queuedTurn!(shownSession, turn).catch(() => null);
          if (!active) return;
          if (st?.ended) {
            // The job ended with no event to say so. Read the list again: it
            // now reads the turn as settled, and refreshTurns bumps the turn's
            // revision on that change, so the Changes and Context tabs re-read.
            refreshTurns.current(shownSession);
            return;
          }
        }
      } finally {
        reading = false;
      }
    };
    const id = setInterval(check, TURN_END_POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [dataSource, shownSession, runningTurns]);

  // The latest turn of each session with its events, from the stream, for the
  // live status on the session cards and in the chat. Only a source that
  // streams fills it; recorded data has no live status.
  const [liveTurns, setLiveTurns] = useState<LiveTurns>({});
  const liveTurnsRef = useRef<LiveTurns>({});
  const liveReads = useRef<Set<string>>(new Set());
  // Read a turn's earlier events once, for a turn the stream joined late.
  const backfillLive = useRef<(session: string, turn: string) => void>(() => {});
  backfillLive.current = (session: string, turn: string) => {
    const key = `${session}/${turn}`;
    if (liveReads.current.has(key)) return;
    liveReads.current.add(key);
    dataSource
      .getTurn(session, turn)
      .then((d) => {
        if (!d) return;
        liveTurnsRef.current = mergeLive(liveTurnsRef.current, session, turn, d.events);
        setLiveTurns(liveTurnsRef.current);
      })
      .catch((err) => console.warn(`Reading turn ${turn} failed:`, err))
      .finally(() => liveReads.current.delete(key));
  };
  // A session a run holds open has a running turn: read its last running turn.
  const loadOpenTurns = useRef<(sessions: SessionSummary[]) => void>(() => {});
  loadOpenTurns.current = (rows: SessionSummary[]) => {
    for (const row of rows) {
      if (!row.open || liveTurnsRef.current[row.id]) continue;
      dataSource
        .getTurns(row.id)
        .then((list) => {
          const running = list.turns.filter((t) => t.state === 'running').pop();
          if (running && !liveTurnsRef.current[row.id]) backfillLive.current(row.id, running.id);
        })
        .catch((err) => console.warn(`Reading session ${row.id} failed:`, err));
    }
  };

  // Every session id seen, so a new session refreshes the lists once.
  const knownSessionsRef = useRef<Set<string>>(new Set());
  for (const s of sessions) knownSessionsRef.current.add(s.id);

  // Follow new events while the cockpit itself is on screen in a tab that is
  // shown. Settings and Runners need no stream, and a tab left hidden gives
  // its stream back (useTabShown): each stream holds one of the browser's
  // few connections to control. Back on the cockpit, the stream starts again
  // from a new snapshot, which reads the list and the shown session again.
  const tabShown = useTabShown();
  // Whether the live stream is up, for the AgentBus card's dot. Undefined
  // before it first says, and for a source that does not stream.
  const [streamUp, setStreamUp] = useState<boolean | undefined>(undefined);
  const pageShown = ownPageShown(page, dataSource);
  const streamOn = tabShown && !pageShown;
  useEffect(() => {
    if (!dataSource.subscribe || !streamOn) return;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let streamDropped = false;
    const unsubscribe = dataSource.subscribe(
      (event) => {
        noteEventTime(event.time);
        refreshNow();
        const live = addLiveEvent(liveTurnsRef.current, event);
        if (live.next !== liveTurnsRef.current) {
          liveTurnsRef.current = live.next;
          setLiveTurns(live.next);
        }
        if (live.backfill) backfillLive.current(event.session, event.turn!);
        // The shown session: an event of a loaded turn joins that turn, and
        // an event that changes the turn list (not yet counted in it) reads
        // the list again. While a session's turns load, its events wait.
        if (event.session === selectedSessionRef.current) streamedRef.current?.push(event);
        if (event.turn) loadingTurnsRef.current.get(`${event.session}/${event.turn}`)?.push(event);
        const s = shownRef.current;
        if (s && event.session === s.session.id && event.turn && s.details[event.turn]) {
          setShown((cur) =>
            cur && cur.session.id === event.session ? { ...cur, details: mergeIntoDetails(cur.details, [event]) } : cur
          );
        }
        if (s && changesTurns(event, s.session.id) && !countedIn(s.cursor, event)) {
          refreshTurns.current(s.session.id);
        }
        // A turn that ends, records its changes or is applied changes what
        // an apply would write: the bar above the message box reads it again.
        if (s && event.session === s.session.id && PREVIEW_KINDS.has(event.kind)) {
          readPreviewRef.current(s.session.id);
        } else if (
          // A discard, update (or Merge), close or failed action of the
          // workspace on screen ended: its job has no session, so it is matched
          // by the workspace it names.
          s &&
          WORKSPACE_KINDS.has(event.kind) &&
          !!s.session.workspace &&
          (event as { workspace?: unknown }).workspace === s.session.workspace
        ) {
          readPreviewRef.current(s.session.id);
        }
        // Every workspace's latest update result, for the apply panel's Merge.
        if (event.kind === 'workspace.updated') {
          const ws = (event as { workspace?: unknown }).workspace;
          const u = (event as { updated?: { result?: unknown; conflicts?: unknown } }).updated;
          if (typeof ws === 'string' && u) {
            const conflicts = Array.isArray(u.conflicts) ? u.conflicts.filter((c): c is string => typeof c === 'string') : undefined;
            setLastUpdates((m) => ({ ...m, [ws]: { result: typeof u.result === 'string' ? u.result : undefined, conflicts } }));
          }
        }
        // The shown turn's Changes and Context tabs re-read when its data
        // changes (its end among them), so a settled turn is current.
        if (s && event.session === s.session.id && TURN_DATA_KINDS.has(event.kind)) {
          setTurnRev((cur) => bumpTurnRev(cur, event, s.details));
        }
        // A Discard dropped some turns' changes: mark them in the conversation.
        if (event.kind === 'workspace.discarded') {
          const dropped = (event.discarded as { dropped_turns?: unknown } | undefined)?.dropped_turns;
          if (Array.isArray(dropped)) markDiscardedRef.current(dropped.filter((t): t is string => typeof t === 'string'));
        }
        // A turn's end: its last reply's plan usage is stored by then, so a
        // subscription agent's bar reads it now rather than at the next
        // minute. A turn whose start is not held may be one: read anyway.
        if (event.kind === 'turn.completed' && !event.probe && onSubscription(liveTurnsRef.current, event)) {
          readSubsRef.current?.();
        }

        // A call adds to its row's total now, unless the shown list already
        // counts it (its seq is at or below the list's) or it was seen before.
        // It is kept until a list that counts it arrives.
        if (
          event.kind === 'model.responded' &&
          !countedIn(listCursorRef.current, event) &&
          !costBufferRef.current.some((c) => c.id === event.id)
        ) {
          const c = streamedCost(event);
          if (c) costBufferRef.current.push(c);
          setAllSessions((list) => list && list.map((row) => addStreamedCost(row, event)));
        }
        if (SUMMARY_KINDS.has(event.kind) || !knownSessionsRef.current.has(event.session)) {
          knownSessionsRef.current.add(event.session);
          setListKey((k) => k + 1);
        } else {
          // Fetch the rows again, at most once per LIST_REFRESH_MS however
          // busy the stream is.
          setAllSessions((list) => list && list.map((row) => (row.id === event.session ? { ...row, last: event.time } : row)));
          if (!refreshTimer) {
            refreshTimer = setTimeout(() => {
              refreshTimer = null;
              setListKey((k) => k + 1);
            }, LIST_REFRESH_MS);
          }
        }
      },
      // The stream starts from this snapshot: show its list, and read the shown
      // session again so its turns are not older than the stream.
      (snapshot, cursor) => {
        snapshotGen.current++;
        takeList({ sessions: snapshot, store: cursor?.store, seq: cursor?.seq }, true);
        // The stream starts over: the live turns are read again from it.
        liveTurnsRef.current = {};
        setLiveTurns({});
        loadOpenTurns.current(snapshot);
        setReloadKey((k) => k + 1);
      },
      (up) => {
        setStreamUp(up);
        // Back after a drop (the service restarted, the network went away):
        // the stream resumes from its cursor, and the list, the shown session
        // and the turn list are read again, so nothing the gap changed is left
        // stale.
        if (!up) streamDropped = true;
        else if (streamDropped) {
          streamDropped = false;
          setListKey((k) => k + 1);
          setReloadKey((k) => k + 1);
          refreshQueueRef.current?.();
        }
      }
    );
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [dataSource, streamOn]);

  // Read the session list. A source that streams hands its first list over
  // with the stream's snapshot, so this only runs for later refreshes there.
  useEffect(() => {
    if (dataSource.subscribe && listKey === 0) return;
    let active = true;
    const gen = snapshotGen.current;
    const read: Promise<SessionList> = dataSource.getSessionList
      ? dataSource.getSessionList()
      : dataSource.getSessions().then((sessions) => ({ sessions }));
    read.then((list) => {
      if (!active || gen !== snapshotGen.current) return;
      takeList(list, false);
    });
    return () => {
      active = false;
    };
  }, [dataSource, listKey]);

  // After any list change, keep the agent and session if they still exist;
  // otherwise take the newest session, and the saved agent it started on
  // (none when that agent is not saved). With no session, the first saved
  // agent. Nothing is picked before the sessions are read: a saved agent
  // listed first would otherwise be kept once they arrive.
  useEffect(() => {
    if (allSessions === null) return;
    const saved = savedAgents ?? [];
    const has = (id?: string | null) => !!id && saved.some((a) => a.id === id);
    // The newest session the person started, to match what the list selects:
    // a hidden asked child (another agent) must not set the + Session agent.
    const newest = personSessions[0];
    setSelectedAgentId((cur) =>
      has(cur) ? cur : newest ? (has(newest.first_agent_id) ? newest.first_agent_id! : null) : (saved[0]?.id ?? null)
    );
  }, [allSessions, personSessions, savedAgents]);
  useEffect(() => {
    // Keep a session chosen by hand even when it is an asked one off the list
    // (opened from its ask's origin link); only fall back to a person session.
    if (selectedSessionId !== null && sessions.some((s) => s.id === selectedSessionId)) return;
    const next = personSessions[0]?.id ?? null;
    if (selectedSessionId === null) setSelectedSessionId(next);
    else chooseSession(next);
  }, [sessions, personSessions]);

  // A session the cockpit just started is selected as soon as it is listed.
  // Declared after the two effects above so its choice wins.
  const [awaitedSession, setAwaitedSession] = useState<string | null>(null);
  // The turn the cockpit just started (POST /api/v0/turns names it), selected
  // as soon as it is in the session on screen. A pick of another session or
  // agent drops it.
  const [awaitedTurn, setAwaitedTurn] = useState<{ session: string; turn: string } | null>(null);
  // Each start or send takes a number; a pick of another session or agent
  // takes one too. A reply counts only if no later start, send or pick came
  // after it, and, for a send, only while its session is still on screen:
  // otherwise a slow reply from a session left behind would take the
  // selection from the turn started where the person is now.
  const sendGenRef = useRef(0);
  const nextSend = () => ++sendGenRef.current;
  // from is the session a send was made in; a start has none, and also waits
  // for its new session to be listed. Both waits are set together, or not at
  // all, so a late start reply never pulls the person away.
  const awaitTurn = (gen: number, started: Started, from?: string) => {
    if (gen !== sendGenRef.current) return;
    if (from !== undefined && shownRef.current?.session.id !== from) return;
    if (from === undefined) setAwaitedSession(started.session);
    setAwaitedTurn(started.turn ? { session: started.session, turn: started.turn } : null);
  };
  // Opens a session from a link in the conversation: the session asked work
  // ran in, which is off the sessions list. One not read yet opens once its
  // row arrives.
  const openSession = (id: string) => {
    nextSend();
    setAwaitedTurn(null);
    if (!allSessions?.some((x) => x.id === id)) {
      setAwaitedSession(id);
      return;
    }
    setAwaitedSession(null);
    chooseSession(id);
  };
  useEffect(() => {
    if (awaitedSession === null) return;
    const s = allSessions?.find((x) => x.id === awaitedSession);
    if (!s) return;
    chooseSession(s.id);
    setAwaitedSession(null);
  }, [allSessions, awaitedSession]);

  // The New session dialog: closed (null), or open with an agent to preselect.
  const [newSession, setNewSession] = useState<{ agent?: string } | null>(null);
  // The apply preview of the conversation on screen: what "Apply to my
  // folder" would write now. Read when the conversation opens, when one of
  // its turns ends, records its changes or is applied, and after an apply.
  // Each read is a job on the runner that may wait up to 30 s, so one read
  // runs at a time per session: asks that come meanwhile make one more read
  // after it. A reply for a session no longer on screen is dropped.
  const [preview, setPreview] = useState<{ session: string; p: ApplyPreview | null; error: string | null } | null>(null);
  const previewReads = useRef(new Map<string, { again: boolean; fresh: boolean }>());
  // Turns a Discard dropped, learned live from workspace.discarded events (and
  // from a discard this cockpit made). The conversation marks them "Discarded".
  // A turn the record already marks (turn.discarded) is folded in at render.
  const [discardedTurns, setDiscardedTurns] = useState<Set<string>>(new Set());
  const markDiscarded = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setDiscardedTurns((prev) => {
      if (ids.every((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);
  const markDiscardedRef = useRef(markDiscarded);
  markDiscardedRef.current = markDiscarded;
  const readPreview = useCallback(
    (sessionId: string, fresh?: boolean) => {
      if (!dataSource.getWorkspaceChanges) return;
      // The preview is of the session's workspace, which GET /sessions folds in.
      const workspace = allSessionsRef.current?.find((x) => x.id === sessionId)?.workspace;
      if (!workspace) return;
      const reads = previewReads.current;
      const inflight = reads.get(sessionId);
      if (inflight) {
        // A read is already in flight: run again after it, and keep fresh if
        // any coalesced caller asked for it, so a Refresh or an apply ending
        // never collapses into a reused, stale preview.
        inflight.again = true;
        inflight.fresh = inflight.fresh || !!fresh;
        return;
      }
      reads.set(sessionId, { again: false, fresh: false });
      const done = (next: (cur: typeof preview) => typeof preview) => {
        if (selectedSessionRef.current === sessionId) setPreview(next);
        const st = reads.get(sessionId);
        reads.delete(sessionId);
        if (st?.again) readPreviewRef.current(sessionId, st.fresh);
      };
      dataSource.getWorkspaceChanges(workspace, fresh).then(
        (p) => done(() => ({ session: sessionId, p, error: null })),
        (err) =>
          done((cur) => ({ session: sessionId, p: cur?.session === sessionId ? cur.p : null, error: (err as Error).message }))
      );
    },
    [dataSource]
  );
  readPreviewRef.current = readPreview;
  // The right panel shows the apply preview instead of a turn.
  const [applyOpen, setApplyOpen] = useState(false);
  // The turn panel's chosen tabs, kept here so they outlive the panel while
  // the apply preview takes its place.
  const panelTabs = usePanelTabs();
  // The file a local-file click asked to open in that turn's Changes tab.
  const [fileReveal, setFileReveal] = useState<{ turnId: string; path: string; n: number } | null>(null);
  // A Changes read that failed for the turn it was about. The tab shows this
  // text. It is dropped when that turn is no longer the one on screen, and
  // when a later read for it succeeds.
  const [fileError, setFileError] = useState<{ sessionId: string; turnId: string; message: string } | null>(null);
  // One lookup at a time on the turn on screen, so a double click does not
  // open and copy both. A click after the person has moved starts its own
  // read. fileSeq is that read's token: an older read finishes without
  // touching the newer one, and without leaving the flag set.
  const fileBusy = useRef(false);
  const fileSeq = useRef(0);
  const fileAt = useRef<{ session: string | null; turn: string | null } | null>(null);
  useEffect(() => {
    setFileError((cur) => (cur && (cur.sessionId !== selectedSessionId || cur.turnId !== selectedTurnId) ? null : cur));
  }, [selectedSessionId, selectedTurnId]);
  useEffect(() => {
    if (!panelOpen) setApplyOpen(false);
  }, [panelOpen]);
  // One turn's own diff, for the turn panel's Changes tab.
  const loadTurnDiff = useCallback((sessionId: string, turnId: string) => dataSource.getTurnDiff!(sessionId, turnId), [dataSource]);
  const loadTurnChanges = useCallback(
    (sessionId: string, turnId: string, before?: number) => dataSource.getTurnChanges!(sessionId, turnId, before),
    [dataSource]
  );
  // A local file in a reply. When that path is one of the turn's changes,
  // open the turn's Changes tab on it. Otherwise copy the full path. The
  // Changes tab is absent without the diff route, so that case copies too.
  // A Direct session keeps no record of its changes, so the tab cannot show
  // the file: the click copies the path and does not open the panel.
  const openTurnFile = (turn: Turn, base: FileBase, file: FileClick) => {
    const here = { session: selectedSessionRef.current, turn: selectedTurnRef.current };
    const samePlace = fileAt.current != null && fileAt.current.session === here.session && fileAt.current.turn === here.turn;
    if (fileBusy.current && samePlace) return;
    const load = dataSource.getTurnChanges;
    const want = fileKey(file.path, base);
    const direct = allSessionsRef.current?.find((s) => s.id === turn.sessionId)?.sandbox === false;
    if (direct || !load || !dataSource.getTurnDiff || !want) {
      copyText(file.full);
      return;
    }
    const mine = ++fileSeq.current;
    fileBusy.current = true;
    fileAt.current = here;
    // The session and turn on screen when this read started, and this read's
    // own token. A newer click takes the token. A slow read then cannot put
    // an old turn back on screen or change a tab the person has since chosen.
    const stillHere = () => mine === fileSeq.current && selectedSessionRef.current === here.session && selectedTurnRef.current === here.turn;
    const show = () => {
      selectTurnLevel(turn);
      setApplyOpen(false);
      columns.forward('turn');
      panelTabs.setTurnTab('changes');
    };
    const lookup = async (): Promise<string | undefined> => {
      let before: number | undefined;
      const seen = new Set<number>();
      for (;;) {
        const page = await load(turn.sessionId, turn.id, before);
        const hit = page.changes.find((f) => fileKey(f.path, base) === want);
        if (hit) return hit.path;
        const next = page.next_before;
        if (next == null || seen.has(next)) return undefined;
        seen.add(next);
        before = next;
      }
    };
    lookup().then(
      (found) => {
        if (mine === fileSeq.current) fileBusy.current = false;
        if (!stillHere()) return;
        if (!found) {
          copyText(file.full);
          return;
        }
        setFileError(null);
        show();
        setFileReveal((cur) => ({ turnId: turn.id, path: found, n: (cur?.n ?? 0) + 1 }));
      },
      (err: unknown) => {
        if (mine === fileSeq.current) fileBusy.current = false;
        if (!stillHere()) return;
        // Keep the API's own words. The tab shows them and does not read
        // again. Copying would say the file was absent when it was not checked.
        const message = err instanceof Error ? err.message : String(err);
        setFileReveal(null);
        setFileError({ sessionId: turn.sessionId, turnId: turn.id, message });
        show();
      }
    );
  };
  // The turn panel's Context tab: a turn's context size and parts, and the
  // session's growth.
  const loadTurnContext = useCallback((sessionId: string, turnId: string) => dataSource.getTurnContext!(sessionId, turnId), [dataSource]);
  const loadSessionContext = useCallback((sessionId: string, before?: number) => dataSource.getSessionContext!(sessionId, before), [dataSource]);
  const loadContext = useMemo(
    () => (dataSource.getCallContext ? (t: string, x: string, full: boolean) => dataSource.getCallContext!(t, x, full) : undefined),
    [dataSource]
  );
  const loadTurn = useCallback((sessionId: string, turnId: string) => dataSource.getTurn(sessionId, turnId), [dataSource]);
  const canStart = !!(dataSource.startRun && dataSource.listAgents);
  // The harnesses the service finds: the agent form reads them.
  const loadHarnesses = useCallback(() => dataSource.getHarnesses!(), [dataSource]);
  const loadModels = useCallback(
    (h: string, a: string, refresh?: boolean) => dataSource.getModels!(h, a, refresh),
    [dataSource],
  );
  const loadSaved = useCallback(() => dataSource.listAgents!(), [dataSource]);
  const canKeepAgents = !!(dataSource.listAgents && dataSource.getHarnesses && dataSource.createAgent);
  // The Connect step of a subscription agent and the Subscriptions part of
  // Settings, where control keeps the person's own subscriptions: every
  // turn uses them.
  const subscriptionApi = useMemo<SubscriptionApi | undefined>(
    () =>
      dataSource.listSubscriptions && dataSource.connectSubscription && dataSource.getConnect &&
      dataSource.connectInput
        ? {
            list: () => dataSource.listSubscriptions!(),
            connect: (h) => dataSource.connectSubscription!(h),
            get: (h) => dataSource.getConnect!(h),
            input: (h, line) => dataSource.connectInput!(h, line),
            cancel: dataSource.cancelConnect ? (h) => dataSource.cancelConnect!(h) : undefined,
            setKey: dataSource.setOpenRouterKey ? (k) => dataSource.setOpenRouterKey!(k) : undefined,
            removeKey: dataSource.removeOpenRouterKey ? () => dataSource.removeOpenRouterKey!() : undefined,
            setAPIKey: dataSource.setAPIKey ? (n, k) => dataSource.setAPIKey!(n, k) : undefined,
            removeAPIKey: dataSource.removeAPIKey ? (n) => dataSource.removeAPIKey!(n) : undefined,
          }
        : undefined,
    [dataSource],
  );
  // The folders the runners own, by reference: a turn built from a snapshot
  // on another machine names its folder by reference, and this gives its
  // name. Read again when the list of sessions grows (a new folder), and
  // when New session opens, which offers them.
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const sessionCount = sessions.length;
  const picking = newSession !== null;
  useEffect(() => {
    if (!dataSource.listFolders) return;
    let active = true;
    dataSource.listFolders().then(
      (list) => active && setFolders(list),
      () => undefined
    );
    return () => {
      active = false;
    };
  }, [dataSource, sessionCount, picking]);
  useEffect(() => {
    if (!dataSource.listAgents || agentsDialog !== null || page !== 'cockpit') return;
    let active = true;
    dataSource.listAgents().then(
      (list) => active && setSavedAgents(list),
      () => undefined
    );
    return () => {
      active = false;
    };
  }, [dataSource, agentsDialog, agentsKey, page]);
  // Read with the agents, so the subscriptions (each agent's key-set, from
  // api_keys and env_keys) are read at the same moment; then when a subscription
  // agent's turn ends (the stream calls readSubsRef), for how much of its
  // plan is left, and once a minute in case no turn tells.
  useEffect(() => {
    if (!dataSource.listSubscriptions || agentsDialog !== null || page !== 'cockpit') return;
    let active = true;
    const read = () =>
      dataSource.listSubscriptions!().then(
        (list) => active && setSubs(list),
        () => undefined
      );
    read();
    readSubsRef.current = read;
    const timer = setInterval(read, SUBSCRIPTIONS_EVERY);
    return () => {
      active = false;
      readSubsRef.current = undefined;
      clearInterval(timer);
    };
  }, [dataSource, agentsDialog, agentsKey, page]);
  // Removes a saved agent from its row, then lists the agents again. A
  // refusal throws the API's words for the row to show.
  // The runners, for the list at the foot of the Agents column.
  // The Settings page, when the source has every settings route.
  const settingsApi = useMemo<SettingsApi | undefined>(() => {
    const d = dataSource;
    if (!d.getSettings || !d.getPolicy || !d.patchPolicy || !d.getInstructions || !d.putInstructions) return undefined;
    return {
      getSettings: () => d.getSettings!(),
      getPolicy: () => d.getPolicy!(),
      patchPolicy: (change, etag) => d.patchPolicy!(change, etag),
      getInstructions: () => d.getInstructions!(),
      putInstructions: (t, etag) => d.putInstructions!(t, etag),
      findConfig: d.findConfig ? () => d.findConfig!() : undefined,
      getCompaction: d.getCompaction ? () => d.getCompaction!() : undefined,
      putCompaction: d.putCompaction ? (c, etag) => d.putCompaction!(c, etag) : undefined,
    };
  }, [dataSource]);
  // The apps the source serves, for the Apps page. Absent when the source has
  // no tool routes.
  const appsApi = useMemo<AppsApi | undefined>(() => {
    const d = dataSource;
    if (!d.listApps || !d.getApp || !d.addApp || !d.removeApp) return undefined;
    return {
      listApps: () => d.listApps!(),
      getApp: (name) => d.getApp!(name),
      addApp: (def) => d.addApp!(def),
      removeApp: (name) => d.removeApp!(name),
    };
  }, [dataSource]);
  const openApps = appsApi ? () => goPage('apps') : undefined;
  // The Settings link opens Settings on its first part; an agent's sign-in
  // dot opens it on Subscriptions, the one place to connect. Absent when the
  // source has no Settings page or keeps no subscriptions.
  const openSettings = () => {
    setSettingsAtSubs(false);
    goPage('settings');
  };
  const openSignIn =
    settingsApi && subscriptionApi
      ? () => {
          setSettingsAtSubs(true);
          goPage('settings');
        }
      : undefined;
  // The sign-in dot beside the agent picker near Send.
  const agentDot = (a: SavedAgent) => <SignInDot signIn={signInOf(a, subs)} onOpen={openSignIn} />;
  const loadRunners = useMemo(
    () =>
      dataSource.readRunners
        ? () => dataSource.readRunners!()
        : dataSource.listRunners
          ? () => dataSource.listRunners!()
          : undefined,
    [dataSource]
  );
  // The runners, read for the online count beside the Runners link and for
  // the Runners page, with the machines waiting for approval; read often
  // while the Runners page is shown.
  const runners = useRunners(loadRunners, page === 'runners' ? RUNNERS_PAGE_POLL_MS : undefined);
  const runnerActions = useMemo(() => {
    const d = dataSource;
    if (!d.approveMachine || !d.refuseMachine || !d.removeRunner) return undefined;
    return {
      approve: (id: string, code: string) => d.approveMachine!(id, code),
      refuse: (id: string) => d.refuseMachine!(id),
      remove: (id: string) => d.removeRunner!(id),
    };
  }, [dataSource]);
  // The workspaces under each machine on the Runners page, with Close.
  const workspacesApi = useMemo(() => {
    const d = dataSource;
    if (!d.listWorkspaces || !d.closeWorkspace) return undefined;
    return {
      list: () => d.listWorkspaces!(),
      close: (id: string) => d.closeWorkspace!(id),
      outcome: d.getWorkspaceOutcome ? (id: string, event: string) => d.getWorkspaceOutcome!(id, event) : undefined,
    };
  }, [dataSource]);
  const runnersOnline = runners.runners ? runners.runners.filter((r) => r.online).length : undefined;
  // Which build the service is, read once: it is fixed for the life of the
  // process. A source without the route, or a read that fails, shows none.
  const [version, setVersion] = useState<VersionInfo | null>(null);
  useEffect(() => {
    if (!dataSource.getVersion) return;
    let live = true;
    dataSource.getVersion().then(
      (v) => live && setVersion(v),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [dataSource]);
  const removeAgent = async (id: string) => {
    await dataSource.removeAgent!(id);
    setAgentsKey((k) => k + 1);
  };
  // A session's first turn: POST /api/v0/turns with no session. A name the
  // person gave is set right after, with PATCH /api/v0/sessions/<id>.
  const launch = async (req: RunRequest, title: string | undefined, gen: number): Promise<Started> => {
    // A listed folder goes by its reference; a typed path goes with the
    // machine picked, whose runner checks it. The session runs there. The
    // source makes the three calls (workspace, session, turn); the name goes
    // on the session, the folder and the mode on the workspace.
    const at = req.folder_ref
      ? { folder_ref: req.folder_ref, machine: req.machine }
      : { folder: req.folder, ...(req.machine ? { machine: req.machine } : {}) };
    const started = await dataSource.startRun!({ ...req, ...at, title });
    refreshQueue?.();
    if (req.folder) rememberFolder(req.folder, req.machine);
    if (req.machine) rememberMachine(req.machine);
    awaitTurn(gen, started);
    return started;
  };
  // A draft's first message: the session and its first turn, in the workspace
  // the draft already holds. The folder was checked when that workspace was
  // made, so this cannot be refused for the folder.
  const launchInWorkspace = async (workspace: string, req: RunRequest, title: string | undefined, gen: number): Promise<Started> => {
    const started = await dataSource.startInWorkspace!(workspace, { ...req, title });
    refreshQueue?.();
    awaitTurn(gen, started);
    return started;
  };
  // A session with no first message is a draft here: an empty conversation
  // with the agent, folder and name. A session in AgentBus starts with its
  // first turn, so the draft becomes one when its first message is sent. Its
  // workspace is made up front (startRun), so the folder is already checked:
  // the draft always names a good folder, and its first message cannot be
  // refused for one.
  // The latest workspace.updated result per workspace, as streamed.
  const [lastUpdates, setLastUpdates] = useState<Record<string, { result?: string; conflicts?: string[] }>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftSeq = useRef(0);
  const startRun = async (req: RunRequest, title?: string) => {
    if (req.prompt.trim() === '') {
      // Make the workspace now, while the form is still open. That is where the
      // runner checks the folder, so a bad one is refused here: the error
      // throws out to the dialog, which stays open with everything kept, and no
      // draft -- and no session -- is ever made from a folder that cannot be
      // used.
      const workspace = await dataSource.createWorkspace!(req);
      if (req.folder) rememberFolder(req.folder, req.machine);
      if (req.machine) rememberMachine(req.machine);
      // Only now that the workspace exists do we make this the newest send and
      // open the draft. Bumping after the refusal above would have stranded any
      // other draft's in-flight turn (it reads the generation to auto-select).
      nextSend();
      setAwaitedTurn(null);
      setAwaitedSession(null);
      setPanelOpen(false);
      setDraft({ id: ++draftSeq.current, req, title, workspace });
      setNewSession(null);
      columns.forward('convo');
      return;
    }
    const gen = nextSend();
    // Its queued copy goes when its turn is listed (it starts): matched by the
    // turn's id the reply names.
    const key = req.idempotency_key ?? messageKey();
    const started = await launch(req, title, gen);
    // The new session shows at once, its first message in it, queued until
    // its turn starts: a draft that already has its session, read from its
    // pending list until the session is listed and replaces it.
    const id = ++draftSeq.current;
    const p: Pending = {
      key,
      prompt: req.prompt,
      turnsAtSend: 0,
      state: started.state === 'queued' ? 'queued' : 'accepted',
      ahead: started.ahead,
      turn: started.turn,
      queuedAt: started.state === 'queued' ? steadyNow() : undefined,
      agent: req.agent,
    };
    setPendingBySession((m) => ({ ...m, [draftKey(id)]: [p] }));
    setPendingAlias((m) => ({ ...m, [started.session]: draftKey(id) }));
    draftRun.current = { id, started: Promise.resolve(started) };
    // Only when nothing was started, sent or picked since: a late reply never
    // pulls the person away (awaitTurn's rule).
    const current = gen === sendGenRef.current;
    if (current && shownRef.current?.session.id !== started.session) {
      setDraft({ id, req: { ...req, prompt: '' }, title, workspace: '', session: started.session });
    } else if (current) {
      setDraft(null);
    }
    setNewSession(null);
    columns.forward('convo');
  };
  // The draft's first message, once sent. A message sent after it goes to
  // the session that one opens, never to a second new session.
  const draftRun = useRef<{ id: number; started: Promise<Started> } | null>(null);
  const sendInDraft = async (d: Draft, prompt: string, agent: string | undefined, key: string): Promise<Started> => {
    const gen = nextSend();
    const id = d.id;
    const first = draftRun.current?.id === id ? draftRun.current.started : null;
    if (first && dataSource.sendMessage) {
      const { session } = await first;
      const next = await dataSource.sendMessage(session, { prompt, agent, idempotency_key: key });
      refreshQueue?.();
      return next;
    }
    const run = launchInWorkspace(d.workspace, { ...d.req, agent: agent ?? d.req.agent, prompt, idempotency_key: key }, d.title, gen);
    draftRun.current = { id, started: run };
    let started: Started;
    try {
      started = await run;
    } catch (err) {
      // Refused (e.g. the agent cannot start, not the folder -- that was
      // checked when the workspace was made). The message stays as a failed
      // card the person can edit and send again, the agent picked right
      // there.
      if (draftRun.current?.started === run) draftRun.current = null;
      throw err;
    }
    // The session reads the draft's messages from here on, so the first one,
    // queued, carries over when the session replaces the draft.
    setPendingAlias((m) => ({ ...m, [started.session]: draftKey(id) }));
    // The draft stays on screen, with its message, until its session is shown.
    setDraft((cur) => (cur && cur.id === id ? { ...cur, session: started.session } : cur));
    return started;
  };
  const sendDraft = draft ? (prompt: string, agent: string | undefined, key: string) => sendInDraft(draft, prompt, agent, key) : undefined;
  // The draft's session is on screen: the draft is done.
  useEffect(() => {
    if (draft?.session && shown?.session.id === draft.session) setDraft(null);
  }, [draft, shown]);

  // Everything the conversation and the panel show comes from the session on
  // screen. While switching, that is still the previous session until the
  // new one's turns load, so never the newly selected row.
  const shownId = shown?.session.id ?? null;
  const shownRow = shownId === null ? undefined : allSessions?.find((s) => s.id === shownId);
  // Each session's "!" commands from before AgentBus 0.5, oldest first, read
  // when the session is shown. 0.5 writes none: a "!" message goes to the
  // agent like any other. So they are asked for only for a session that
  // started before this control first ran 0.5, when its settings database
  // was made (GET /api/v0/settings, created). A source without that route,
  // or a read of it that fails, asks for every session, as before.
  const [settingsMade, setSettingsMade] = useState<{ at?: string } | null>(dataSource.getSettings ? null : {});
  useEffect(() => {
    if (!dataSource.getSettings) return;
    let active = true;
    dataSource.getSettings().then(
      (got) => active && setSettingsMade({ at: got.value.created }),
      () => active && setSettingsMade({})
    );
    return () => {
      active = false;
    };
  }, [dataSource]);
  const selectedStarted = selectedSessionId === null ? undefined : allSessions?.find((s) => s.id === selectedSessionId)?.started;
  const mayHoldCommands =
    settingsMade !== null && !(settingsMade.at && selectedStarted && Date.parse(selectedStarted) >= Date.parse(settingsMade.at));
  const [commandsBySession, setCommandsBySession] = useState<Record<string, ShellRun[]>>({});
  useEffect(() => {
    if (selectedSessionId === null || !dataSource.getCommands || !mayHoldCommands) return;
    let active = true;
    const id = selectedSessionId;
    dataSource
      .getCommands(id)
      .then((runs) => {
        if (!active) return;
        setCommandsBySession((m) => ({ ...m, [id]: runs.reduce((list, r) => addRun(list, r), m[id] ?? []) }));
      })
      .catch((err) => console.warn(`Reading the commands of ${id} failed:`, err));
    return () => {
      active = false;
    };
  }, [dataSource, selectedSessionId, reloadKey, mayHoldCommands]);
  // The messages sent from each session that are not turns yet, kept here so
  // they outlive a switch to another session and back.
  const [pendingBySession, setPendingBySession] = useState<Record<string, Pending[]>>({});
  // A session started from a draft keeps the draft's messages: its pending
  // list is the draft's (draftKey), so the first message, still queued, does
  // not leave the screen when the session replaces the draft.
  const [pendingAlias, setPendingAlias] = useState<Record<string, string>>({});
  const pendingKey = (session: string) => pendingAlias[session] ?? session;
  // What the person had typed in each session's box, so a switch to another
  // session and back shows it again. Read once, when the session is shown.
  const draftsRef = useRef(new Map<string, string>());
  const onDraftChange = useCallback((id: string, text: string) => {
    if (text === '') draftsRef.current.delete(id);
    else draftsRef.current.set(id, text);
  }, []);
  const shownSessionId = shownId;
  const onPending = useCallback(
    (update: PendingUpdate) => {
      if (!shownSessionId) return;
      const k = pendingAlias[shownSessionId] ?? shownSessionId;
      setPendingBySession((m) => ({ ...m, [k]: update(m[k] ?? []) }));
    },
    [shownSessionId, pendingAlias]
  );
  // Reads a queued message's turn; the same function across renders, so the
  // poll that uses it is not restarted by every turn-list refresh.
  const queuedTurn = useMemo(
    () => (dataSource.queuedTurn ? (session: string, turn: string) => dataSource.queuedTurn!(session, turn) : undefined),
    [dataSource]
  );
  // A message is always POST /api/v0/turns, which queues it behind the
  // session's running turn: it never waits for that turn to end. key matches
  // the queued message to the turn that runs it.
  const sendMessage = dataSource.sendMessage
    ? async (prompt: string, agent: string | undefined, key: string): Promise<Started | undefined> => {
        if (shownId === null) return undefined;
        const gen = nextSend();
        const from = shownId;
        const started = await dataSource.sendMessage!(from, { prompt, agent, idempotency_key: key });
        refreshQueue?.();
        awaitTurn(gen, started, from);
        return started;
      }
    : undefined;

  // A new name for a session: PATCH /api/v0/sessions/<id>. The row shows it
  // at once, and the list is read again. A refusal rejects with the API's
  // words, for the row or the header to show.
  const renameSession = dataSource.renameSession
    ? async (id: string, title: string) => {
        await dataSource.renameSession!(id, title);
        const t = title.trim();
        setAllSessions((list) => list && list.map((row) => (row.id === id ? { ...row, title: t } : row)));
        setListKey((k) => k + 1);
      }
    : undefined;

  // PATCH archived: true|false. Archive is only a view, so the row hides or
  // shows at once (archivedOverride) and the list is read again; nothing is
  // removed and the session can still take a turn.
  const archiveSession = dataSource.archiveSession
    ? async (id: string, on: boolean) => {
        const r = await dataSource.archiveSession!(id, on);
        if (r === 'ok') {
          setArchivedOverride((m) => {
            const next = new Map(m);
            next.set(id, on);
            return next;
          });
          setListKey((k) => k + 1);
        }
        return r;
      }
    : undefined;
  // Every event of the session, saved as one .jsonl file.
  const exportSession = dataSource.getSessionEvents
    ? async (id: string) => {
        const events = await dataSource.getSessionEvents!(id);
        const title = allSessionsRef.current?.find((s) => s.id === id)?.title ?? id;
        saveRecord(recordFileName(title, id), events);
      }
    : undefined;

  // The turns the person asked to stop, by id, from the click until the turn
  // list says the turn is no longer running. Kept here rather than in the
  // conversation, so it holds across a switch to another session and back.
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  // The same set, read by a click before the next render, so two quick clicks
  // send one stop.
  const stoppingRef = useRef(stopping);
  stoppingRef.current = stopping;
  const dropStopping = (turnId: string) =>
    setStopping((cur) => {
      if (!cur.has(turnId)) return cur;
      const next = new Set(cur);
      next.delete(turnId);
      return next;
    });
  // POST /api/v0/turns/<id>/stop. The turn's end arrives through the stream
  // (its run.ended reads the turn list again). A 409 means it had ended
  // already: read the list again now. Any other refusal rejects with the
  // API's words, for the conversation to show.
  // Cancel (or Edit) a message still queued: stop its turn before it starts.
  const cancelQueued = dataSource.stopTurn
    ? async (turn: string) => {
        const r = await dataSource.stopTurn!(turn);
        refreshQueue?.();
        return r;
      }
    : undefined;
  const stopTurn = dataSource.stopTurn
    ? async (turn: Turn) => {
        if (stoppingRef.current.has(turn.id)) return;
        stoppingRef.current = new Set(stoppingRef.current).add(turn.id);
        setStopping((cur) => new Set(cur).add(turn.id));
        try {
          const r = await dataSource.stopTurn!(turn.id);
          if (r === 'not-running') {
            dropStopping(turn.id);
            refreshTurns.current(turn.sessionId);
          }
        } catch (err) {
          dropStopping(turn.id);
          throw err;
        }
      }
    : undefined;

  // Read the selected session's turns when the selection changes, or on a
  // reload, with the events of the turn that will be selected, so the
  // session, its turns and the open turn change on screen together.
  const loadedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedSessionId === null) {
      setShown(null);
      setSelectedTurnId(null);
      return;
    }
    let active = true;
    const sessionId = selectedSessionId;
    streamedRef.current = [];
    (async () => {
      const list = await dataSource.getTurns(sessionId);
      if (!active) return;
      const firstLoad = loadedSessionRef.current === null;
      const sameSession = loadedSessionRef.current === sessionId;
      const prev = selectedTurnRef.current;
      const kept = sameSession && prev ? list.turns.find((t) => t.id === prev) : undefined;
      const pick = kept ?? list.turns[0] ?? null;
      const details: Record<string, TurnDetail> = {};
      if (pick) {
        const d = await dataSource.getTurn(sessionId, pick.id);
        if (!active) return;
        details[pick.id] = d ?? turnDetail([]);
      }
      // Each shown turn's text comes from the single turn; load it before
      // the turns go on screen, so they show with their prompt and reply.
      const texts = await loadTexts(sessionId, list.turns);
      if (!active) return;
      // Events streamed while the turns were in flight join their turn; one
      // that changed the list after its cursor reads the list again.
      const streamed = streamedRef.current ?? [];
      streamedRef.current = null;
      const cursor = { store: list.store, seq: list.seq };
      const row = allSessionsRef.current?.find((s) => s.id === sessionId) ?? emptyRow(sessionId);
      setShown({ session: { ...row, turnsList: list.turns }, cursor, details: mergeIntoDetails(details, streamed), texts });
      loadedSessionRef.current = sessionId;
      // Navigation belongs to the session on screen. A click made in the old
      // session while this one loaded acted on the old one; this session
      // opens on its own session panel. Only the first load opens on turn 1.
      if (!sameSession && !firstLoad) {
        setLevel('session');
        setSelectedCallId(null);
      }
      setSelectedTurnId(pick?.id ?? null);
      if (!sameSession) setSelection(null);
      if (streamed.some((e) => changesTurns(e, sessionId) && !countedIn(cursor, e))) refreshTurns.current(sessionId);
    })().catch((err) => {
      if (active) console.warn(`Reading session ${sessionId} failed:`, err);
    });
    return () => {
      active = false;
    };
  }, [dataSource, selectedSessionId, reloadKey]);

  // The turns on screen, each with its events when they are loaded.
  const turns = useMemo(
    () =>
      shown
        ? shown.session.turnsList.map((t) => {
            // The turn's text comes from the single turn (texts); when a turn's
            // detail is loaded its own text is the fallback, so a failed text
            // fetch does not leave the prompt empty.
            const text = shown.texts[t.id];
            const detail = shown.details[t.id];
            const row = {
              ...t,
              prompt: text?.prompt ?? detail?.prompt ?? t.prompt,
              reply: text?.reply ?? detail?.agentResponse ?? t.reply,
              // Every answer: from the single turn when it has them (no need to
              // open the turn), else from the loaded events.
              answers: text?.replies ?? detail?.answers ?? t.answers,
            };
            return detail ? { ...row, detail } : row;
          })
        : [],
    [shown]
  );
  const selectedTurn = turns.find((t) => t.id === selectedTurnId) ?? null;


  // A stop is over once the shown turn list says its turn is not running.
  useEffect(() => {
    if (!shown || stopping.size === 0) return;
    for (const t of shown.session.turnsList) if (stopping.has(t.id) && t.state !== 'running') dropStopping(t.id);
  }, [shown, stopping]);
  // The session as the screens see it: its latest row and its turns.
  const sessionView: SessionDetail | null = shown
    ? {
        ...(shownRow ?? shown.session),
        turnsList: turns,
        archived: (archivedOverride.get(shown.session.id) ?? !!shownRow?.archived) || undefined,
      }
    : null;

  // The conversation on screen's apply preview, read when it opens.
  const previewSession = sessionView?.id ?? null;
  useEffect(() => {
    if (previewSession) readPreview(previewSession);
  }, [previewSession, readPreview]);
  const shownPreview = preview && preview.session === previewSession ? preview : null;
  // The folder names of the shown session's workspace, when it has several:
  // Review lists each folder's files under its name. Read once per workspace.
  const shownWorkspace = sessionView?.sandbox ? sessionView.workspace : undefined;
  const [workspaceFolders, setWorkspaceFolders] = useState<{ ws: string; names: string[] } | null>(null);
  useEffect(() => {
    if (!shownWorkspace || !dataSource.getWorkspace) return;
    let live = true;
    dataSource.getWorkspace(shownWorkspace).then(
      (w) => live && setWorkspaceFolders({ ws: shownWorkspace, names: (w.folders ?? []).map((f) => f.name ?? '').filter((n) => n !== '') }),
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [shownWorkspace, dataSource]);
  const reviewFolders =
    workspaceFolders && workspaceFolders.ws === shownWorkspace && workspaceFolders.names.length > 1 ? workspaceFolders.names : undefined;
  // The copy has more files than a checkpoint holds: its changes cannot be tracked.
  const previewTooBig = refusedTooBig(shownPreview?.error);
  const openApply = () => {
    setApplyOpen(true);
    columns.forward('turn');
    // Opening the apply view takes a fresh preview: the folder may have
    // changed since the reused one was taken.
    if (previewSession) readPreview(previewSession, true);
  };

  // A Review prefill for the message box: the Review button beside Apply
  // fills it, the conversation takes it once, then it is cleared.
  const [prefill, setPrefill] = useState<{ session: string; text: string; agent?: string } | null>(null);
  // The harness (vendor) an agent reference belongs to: a saved agent's
  // harness, or the reference itself when it already names a harness.
  const harnessOfRef = (ref: string) => savedAgents?.find((a) => a.id === ref)?.harness ?? ref;
  // Agents offered as reviewer, one of a different vendor than the agent that
  // did the work first, which becomes the default.
  const authorHarness = harnessOfRef(currentAgent(turns));
  const reviewOptions = [...(savedAgents ?? [])].sort(
    (a, b) => Number(a.harness === authorHarness) - Number(b.harness === authorHarness)
  );
  const defaultReviewer = reviewOptions.find((a) => a.harness !== authorHarness)?.id ?? reviewOptions[0]?.id ?? '';
  // Fills the message box with a plain review request for the turn the apply
  // preview names, and switches the picker beside Send to the reviewer. The
  // person presses Send; nothing is sent here.
  const reviewTurn = (agentId: string) => {
    const p = shownPreview?.p;
    if (!previewSession || !p?.turn) return;
    const n = turns.find((t) => t.id === p.turn)?.turnNumber;
    const what = n ? `the changes from turn ${n}` : 'these changes';
    setPrefill({ session: previewSession, text: `Please review ${what}. List any problems, most serious first.`, agent: agentId });
  };
  // Fills the message box with the goal-only merge request (Merge put both
  // sides in the files; the agent finds them), and switches the picker beside
  // Send to the agent. The person presses Send.
  const mergeTurn = (agentId: string, _files: string[]) => {
    if (!previewSession) return;
    setPrefill({ session: previewSession, text: MERGE_REQUEST, agent: agentId });
  };

  // Load the events of a selected turn that has none yet. Events streamed
  // while they load join them.
  useEffect(() => {
    const s = shownRef.current;
    const turnId = selectedTurnId;
    if (!s || !turnId || s.details[turnId] || !s.session.turnsList.some((t) => t.id === turnId)) return;
    const sessionId = s.session.id;
    const key = `${sessionId}/${turnId}`;
    if (loadingTurnsRef.current.has(key)) return;
    loadingTurnsRef.current.set(key, []);
    dataSource
      .getTurn(sessionId, turnId)
      .then((d) => {
        const streamed = loadingTurnsRef.current.get(key) ?? [];
        setShown((cur) =>
          cur && cur.session.id === sessionId && !cur.details[turnId]
            ? { ...cur, details: { ...cur.details, [turnId]: addTurnEvents(d ?? turnDetail([]), streamed) } }
            : cur
        );
      })
      .catch((err) => console.warn(`Reading turn ${turnId} failed:`, err))
      .finally(() => loadingTurnsRef.current.delete(key));
  }, [dataSource, selectedTurnId, shown]);

  // Select the awaited turn once the session on screen lists it. Declared
  // after the load effect, so this choice wins over the load's default.
  useEffect(() => {
    if (!awaitedTurn || !shown || shown.session.id !== awaitedTurn.session) return;
    const turn = shown.session.turnsList.find((t) => t.id === awaitedTurn.turn);
    if (!turn) return;
    selectTurnLevel(turn);
    setSelection(null);
    setAwaitedTurn(null);
  }, [shown, awaitedTurn]);

  // The level on screen. No turn shows the session (a session with no turns
  // yet), whatever was selected before; a call that is not in the shown turn
  // shows the turn.
  const callShown = !!selectedTurn?.detail?.modelCalls.some((p) => p.requested.id === selectedCallId);
  const shownLevel: Level = !selectedTurn ? 'session' : level === 'call' && !callShown ? 'turn' : level;
  const dialogOpenRef = useRef(false);
  // The page of its own on screen, if any. A source without the page's
  // routes shows the cockpit at that address instead.
  // A page of its own counts as a dialog: Esc leaves the cockpit under it as it is.
  dialogOpenRef.current = newSession !== null || agentsDialog !== null || pageShown;

  // Esc first leaves a focused text box, then collapses an open row in the
  // turn panel, then closes the panel. The panel's Session and Turn links
  // step up a level.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || dialogOpenRef.current) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) {
        t.blur();
        return;
      }
      if (agentsMenuRef.current) {
        setAgentsMenu(false);
        return;
      }
      if (!panelOpenRef.current) return;
      if (panelEscRef.current?.()) return;
      closePanelRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The pages of their own, each at its address. A source without the
  // page's routes shows the cockpit.
  if (pageShown && page === 'apps') {
    return (
      <AppsPage
        api={appsApi!}
        onBack={() => goPage('cockpit')}
        onRunners={loadRunners ? () => goPage('runners') : undefined}
        onSettings={settingsApi ? openSettings : undefined}
        runnersOnline={runnersOnline}
        version={version ? versionLabel(version) : undefined}
        sourceLabel={sourceLabel}
        streamUp={dataSource.subscribe ? streamUp ?? false : undefined}
        onDisconnect={onDisconnect}
        disconnectLabel={disconnectLabel}
      />
    );
  }
  if (pageShown && page === 'runners') {
    return (
      <RunnersPage
        taskOf={taskOfWorkspace}
        commands={commands?.all}
        onStopCommand={commands?.stop}
        runners={runners.runners}
        error={runners.error}
        pending={runners.pending}
        reload={runners.reload}
        actions={runnerActions}
        workspaces={workspacesApi}
        folders={folders}
        queue={queueView ? { turns: queueView.turns, error: queueView.error, titleOf } : undefined}
        onBack={() => goPage('cockpit')}
        onApps={openApps}
        onRunners={loadRunners ? () => goPage('runners') : undefined}
        onSettings={settingsApi ? openSettings : undefined}
        runnersOnline={runnersOnline}
        version={version ? versionLabel(version) : undefined}
        sourceLabel={sourceLabel}
        streamUp={dataSource.subscribe ? streamUp ?? false : undefined}
        onDisconnect={onDisconnect}
        disconnectLabel={disconnectLabel}
      />
    );
  }
  if (pageShown && page === 'settings') {
    return (
      <SettingsPage
        api={settingsApi!}
        onBack={() => goPage('cockpit')}
        onApps={openApps}
        onRunners={loadRunners ? () => goPage('runners') : undefined}
        onSettings={settingsApi ? openSettings : undefined}
        runnersOnline={runnersOnline}
        version={version ? versionLabel(version) : undefined}
        sourceLabel={sourceLabel}
        streamUp={dataSource.subscribe ? streamUp ?? false : undefined}
        onDisconnect={onDisconnect}
        disconnectLabel={disconnectLabel}
        subscriptions={subscriptionApi}
        atSubscriptions={settingsAtSubs}
      />
    );
  }

  if (loading) {
    return (
      <div id="app" className="app-loading">
        <Loading />
      </div>
    );
  }

  return (
    <FoldersContext.Provider value={folders}>
    <div
      id="app"
      className={`${panelOpen ? 'panel' : 'nopanel'}${agentsMenu && columns.narrow ? ' agents-open' : ''}`}
      data-column={columns.column}
    >
      {agentsMenu && columns.narrow && (
        <div className="agents-scrim" aria-hidden="true" onClick={() => setAgentsMenu(false)} />
      )}
      <AgentsColumn
        agents={savedAgents ?? []}
        selectedAgentId={selectedAgentId}
        sourceLabel={sourceLabel}
        streamUp={dataSource.subscribe ? streamUp ?? false : undefined}
        onDisconnect={onDisconnect}
        disconnectLabel={disconnectLabel}
        // Selecting an agent only marks it, for "+ Session": the session on
        // screen and the list stay.
        onSelectAgent={(id) => {
          setSelectedAgentId(id);
          setAgentsMenu(false);
        }}
        onAddAgent={canKeepAgents ? () => setAgentsDialog({}) : undefined}
        onEditAgent={canKeepAgents && dataSource.updateAgent ? (a) => setAgentsDialog({ edit: a }) : undefined}
        onRemoveAgent={canKeepAgents && dataSource.removeAgent ? removeAgent : undefined}
        onRunners={loadRunners ? () => goPage('runners') : undefined}
        runnersOnline={runnersOnline}
        version={version ? versionLabel(version) : undefined}
        onApps={openApps}
        onSettings={settingsApi ? openSettings : undefined}
        subscriptions={subs}
        onOpenSignIn={openSignIn}
      />

      <SessionsColumn
        sessions={personSessions}
        active={active}
        live={dataSource.subscribe ? liveTurns : undefined}
        // A narrow screen shows the Sessions column alone, and every card is
        // a button that opens its conversation, the one open before included.
        selectedSessionId={draft || (columns.narrow && columns.column === 'sessions') ? null : selectedSessionId}
        onSelectSession={(sessId) => {
          // The session already on screen, tapped on a narrow screen: only
          // its column opens. A send in it still selects its turn.
          if (sessId === selectedSessionId && !draft) {
            columns.forward('convo');
            return;
          }
          setDraft(null);
          nextSend();
          setAwaitedTurn(null);
          setAwaitedSession(null);
          chooseSession(sessId);
          columns.forward('convo');
        }}
        onAgents={() => setAgentsMenu(true)}
        // New session starts on the selected agent when it is a saved one.
        // With no agent saved yet, + Session waits: the chat says to add one first.
        onNewSession={
          canStart && (!canKeepAgents || (savedAgents?.length ?? 0) > 0)
            ? () => setNewSession({ agent: savedAgents?.find((a) => a.id === selectedAgentId)?.id })
            : undefined
        }
        onRename={renameSession}
        agents={savedAgents}
        empty={personSessions.length === 0}
        showArchived={showArchived}
        archivedCount={archivedCount}
        onToggleArchived={archivedCount > 0 || showArchived ? () => setShowArchived((v) => !v) : undefined}
      />

      {draft ? (
        <ConvoColumn
          key={`draft-${draft.id}`}
          session={{
            ...emptyRow(`draft-${draft.id}`),
            agent: draft.req.agent,
            title: draft.title || 'New session',
            folder: draft.req.folder,
            folder_ref: draft.req.folder_ref,
            resumable: true,
            turnsList: [],
          }}
          resumable
          onSend={sendDraft}
          pending={pendingBySession[draftKey(draft.id)] ?? NO_PENDING}
          onCancelQueued={cancelQueued}
          onPending={(u: PendingUpdate) => setPendingBySession((m) => ({ ...m, [draftKey(draft.id)]: u(m[draftKey(draft.id)] ?? []) }))}
          selectedTurn={null}
          onSelectTurn={() => undefined}
          level="session"
          panelOpen={false}
          agentName={nameOf(draft.req.agent)}
          agents={savedAgents}
          defaultAgent={draft.req.agent}
          onAddAgent={canKeepAgents ? () => setAgentsDialog({}) : undefined}
          agentDot={agentDot}
          onRename={async (_id, t) => setDraft((d) => (d ? { ...d, title: t.trim() } : d))}
          onBack={() => columns.back('convo')}
        />
      ) : sessionView ? (
        <ConvoColumn
          key={sessionView.id}
          session={sessionView}
          resumable={sessionView.resumable}
          archived={sessionView.archived}
          open={sessionView.open}
          onSend={sendMessage}
          prefill={prefill}
          onPrefillTaken={() => setPrefill(null)}
          savedDraft={draftsRef.current.get(sessionView.id)}
          onDraftChange={onDraftChange}
          queuedTurn={queuedTurn}
          keyed={!!dataSource.queuedTurn}
          pending={pendingBySession[pendingKey(sessionView.id)] ?? NO_PENDING}
          onNearTurns={dataSource.getTurnText ? (ids: string[]) => loadNear(sessionView.id, ids) : undefined}
          onPending={onPending}
          onStop={stopTurn}
          onCancelQueued={cancelQueued}
          stopping={stopping}
          discardedTurns={discardedTurns}
          live={dataSource.subscribe ? liveTurns[sessionView.id] : undefined}
          selectedTurn={selectedTurn}
          onSelectTurn={clickTurn}
          onOpenFile={openTurnFile}
          level={shownLevel}
          panelOpen={panelOpen}
          agentName={nameOf(sessionView.agent)}
          agents={savedAgents}
          onAddAgent={canKeepAgents ? () => setAgentsDialog({}) : undefined}
          agentDot={agentDot}
          asked={askedOf(sessionView.id)}
          agentCommands={commands?.ofSession(sessionView.id)}
          onStopCommand={commands?.stop}
          onOpenSession={openSession}
          onRename={renameSession}
          applyBar={
            previewTooBig
              ? { count: 0, onReview: openApply, tooBig: true }
              : shownPreview?.p?.unapplied
                ? { count: shownPreview.p.count || shownPreview.p.files.length, onReview: openApply }
                : null
          }
          onArchiveSession={archiveSession}
          onExport={exportSession}
          commands={commandsBySession[sessionView.id]}
          approvals={<ApprovalsPanel dataSource={dataSource} sessionId={sessionView.id} />}
          onBack={() => columns.back('convo')}
        />
      ) : (
        <main id="convo">
          <header id="c-head" className="colhead">
            <BackButton label="Sessions" onClick={() => columns.back('convo')} />
            <div className="colhead-title">{allSessions.length === 0 ? `No ${SESSIONS} yet` : `No ${SESSION} selected`}</div>
          </header>
          <div id="c-msgs" className="colbody c-empty">
            <p className="empty">
              {allSessions.length === 0
                ? canStart
                  ? savedAgents?.length === 0
                    ? `First add an agent with + Agent. Then start a ${SESSION}.`
                    : `Start one with + ${Session}.`
                  : `${Sessions} show here when an agent runs through ${PRODUCT}.`
                : `Pick a ${SESSION} from the list.`}
            </p>
          </div>
        </main>
      )}

      {/* Between 900 and 1200px the panel lies over the chat: a scrim covers
          the chat, and a click on it closes the panel (styles/narrow.css). */}
      {panelOpen && <div className="panel-scrim" aria-hidden="true" onClick={closePanel} />}
      <div className="panel-slot" hidden={!panelOpen}>
      {applyOpen && previewSession ? (
        <ApplyPanel
          key={previewSession}
          preview={shownPreview?.p ?? null}
          error={shownPreview?.error}
          apply={
            dataSource.applyWorkspace && sessionView?.workspace
              ? (turn: string) => dataSource.applyWorkspace!(sessionView.workspace!, turn)
              : undefined
          }
          readOutcome={
            dataSource.getWorkspaceOutcome && sessionView?.workspace
              ? (event: string) => dataSource.getWorkspaceOutcome!(sessionView.workspace!, event)
              : undefined
          }
          onApplyEnded={() => readPreview(previewSession, true)}
          onRefresh={dataSource.getWorkspaceChanges ? () => readPreview(previewSession, true) : undefined}
          onClose={closePanel}
          review={
            sendMessage && reviewOptions.length > 0
              ? {
                  options: reviewOptions.map((a) => ({ id: a.id, name: a.name })),
                  defaultAgent: defaultReviewer,
                  onReview: reviewTurn,
                  onMerge: mergeTurn,
                }
              : undefined
          }
          discard={
            // Discard drops a sandbox copy's changes; a direct session has none.
            sessionView?.sandbox && sessionView?.workspace && dataSource.discardWorkspace
              ? () => dataSource.discardWorkspace!(sessionView.workspace!)
              : undefined
          }
          onDiscarded={(dropped) => {
            markDiscarded(dropped);
            readPreview(previewSession, true);
          }}
          update={
            // Update merges the person's folder into a sandbox copy; a direct
            // session has no copy to update.
            sessionView?.sandbox && sessionView?.workspace && dataSource.updateWorkspace
              ? (mode?: 'merge') => dataSource.updateWorkspace!(sessionView.workspace!, mode)
              : undefined
          }
          lastUpdate={sessionView?.workspace ? lastUpdates[sessionView.workspace] ?? null : null}
          folders={reviewFolders}
        />
      ) : (
      <RightPanel
        turn={selectedTurn}
        totalTurns={turns.length}
        selection={selection}
        onSelectEvent={selectEvent}
        level={shownLevel}
        session={sessionView}
        sessionCostUsd={sessionView?.cost_usd}
        sessionCostComplete={sessionView?.cost_complete}
        agentName={nameOf(sessionView?.agent)}
        callId={selectedCallId}
        onLevel={(l) => (l === 'session' ? selectSessionLevel() : setLevel(l))}
        onSelectTurn={selectTurnLevel}
        onSelectCall={selectCall}
        onOpenEvent={openEvent}
        onOpenFile={openTurnFile}
        revealFile={fileReveal}
        changesError={
          fileError && selectedTurn && fileError.sessionId === selectedTurn.sessionId && fileError.turnId === selectedTurn.id
            ? fileError.message
            : undefined
        }
        loadContext={loadContext}
        loadTurn={loadTurn}
        live={!!dataSource.subscribe}
        onClose={closePanel}
        escRef={panelEscRef}
        loadDiff={dataSource.getTurnDiff ? loadTurnDiff : undefined}
        loadChanges={dataSource.getTurnChanges ? loadTurnChanges : undefined}
        loadTurnContext={dataSource.getTurnContext ? loadTurnContext : undefined}
        loadSessionContext={dataSource.getSessionContext ? loadSessionContext : undefined}
        panelOpen={panelOpen}
        tooBig={previewTooBig}
        // Streamed events bump turnRev; a fresh snapshot (the stream restarts,
        // e.g. on returning to a hidden tab) bumps reloadKey. Either means the
        // turn's data may have moved since the fetching tabs last read — a
        // stream that was down could have missed its end — so fold in both.
        rev={selectedTurn ? (turnRev[selectedTurn.id] ?? 0) + reloadKey : 0}
        tabs={panelTabs}
      />
      )}
      </div>

      {newSession && canStart && (
        <NewSessionDialog
          loadAgents={loadSaved}
          loadHarnesses={dataSource.getHarnesses ? loadHarnesses : undefined}
          onStart={startRun}
          folders={folders}
          machines={runners.runners ?? []}
          onClose={() => setNewSession(null)}
          initialAgent={newSession.agent}
          onAddAgent={
            canKeepAgents
              ? () => {
                  setNewSession(null);
                  setAgentsDialog({});
                }
              : undefined
          }
        />
      )}
      {agentsDialog && canKeepAgents && (
        <AgentsDialog
          loadHarnesses={loadHarnesses}
          createAgent={(f) => dataSource.createAgent!(f)}
          updateAgent={(id, f) => dataSource.updateAgent!(id, f)}
          subscriptions={subscriptionApi}
          loadModels={dataSource.getModels ? loadModels : undefined}
          edit={agentsDialog.edit}
          onClose={() => setAgentsDialog(null)}
        />
      )}
    </div>
    </FoldersContext.Provider>
  );
};

export default App;
