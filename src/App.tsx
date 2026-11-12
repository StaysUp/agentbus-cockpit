import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import rawSessionsJsonl from '../testdata/sessions-v0.jsonl?raw';
import { AgentsColumn } from './components/AgentsColumn';
import { ConvoColumn, Pending, PendingUpdate } from './components/ConvoColumn';
import { AgentsDialog } from './components/AgentsDialog';
import { SettingsPage } from './components/SettingsPage';
import { RunnersPage } from './components/RunnersPage';
import { RUNNERS_PAGE_POLL_MS, useRunners } from './components/RunnersList';
import { usePage } from './page';
import { sandboxOffer, type SettingsApi } from './data/settings';
import { useTabShown } from './data/useTabShown';
import { SubscriptionApi } from './components/ConnectStep';
import { NewSessionDialog } from './components/NewSessionDialog';
import { ChangesDialog } from './components/ChangesDialog';
import { RightPanel } from './components/RightPanel';
import { SessionsColumn } from './components/SessionsColumn';
import { FolderInfo, FoldersContext, rememberFolder, rememberMachine } from './data/folders';
import { ReplayDataSource } from './data/ReplayDataSource';
import { applyList, countedIn, isNewerList, ListCursor, StreamedCost, streamedCost } from './data/sessionList';
import { addLiveEvent, LiveTurns, mergeLive, noteEventTime } from './data/liveStatus';
import { refreshNow } from './utils/useNow';
import { versionLabel } from './utils/format';
import { ApiTurn, QueueSource } from './data/jobs';
import { useQueue } from './data/useJobs';
import { addRun } from './data/shell';
import { addStreamedCost, addTurnEvents, buildAgents, createEmptyUsage, sessionGroup, turnDetail } from './data/turns';
import {
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
  Turn,
  TurnDetail,
  VersionInfo,
} from './types';

// Whether page is a page of its own that the source has the routes for:
// Runners needs the runners route, Settings every settings route. A source
// without them shows the cockpit at that address instead.
function ownPageShown(page: string, d: DataSource): boolean {
  if (page === 'runners') return !!(d.readRunners || d.listRunners);
  if (page === 'settings') return !!(d.getSettings && d.getPolicy && d.putPolicy && d.getInstructions && d.putInstructions);
  return false;
}

// No pending messages, the same array each time.
const NO_PENDING: Pending[] = [];

// The longest wait before the sessions are fetched again after an event.
const LIST_REFRESH_MS = 500;

// How often a running turn of the shown session is read, to see it end.
export const TURN_END_POLL_MS = 2000;

// Kinds that change a session's summary (agent, folder, open) as the service
// computes it; on these, fetch the sessions again at once.
const SUMMARY_KINDS = new Set(['session.registered', 'session.opened', 'session.closed', 'session.renamed', 'events.dropped']);

// Kinds that change a row of GET /api/v0/turns: a new turn, its end, its
// cost and usage, its state, its model calls, model and reply. On these the
// shown session's turns are read again.
const TURN_LIST_KINDS = new Set([
  'turn.started',
  'turn.completed',
  'model.requested',
  'model.responded',
  'session.opened',
  'session.closed',
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

function emptyRow(id: string): SessionSummary {
  return { id, agent: '', client: '', title: id, started: '', last: '', open: false, turns: 0, usage: createEmptyUsage() };
}

interface AppProps {
  dataSource?: DataSource;
  // Where the data comes from, shown at the foot of the Agents column.
  sourceLabel?: string;
  onDisconnect?: () => void;
  disconnectLabel?: string;
  // The service's turn queue, when it keeps one: a turn that ended can be
  // reviewed, and a queued or running review stopped.
  queue?: QueueSource;
}

export const App: React.FC<AppProps> = ({ dataSource: propDataSource, sourceLabel, onDisconnect, disconnectLabel, queue }) => {
  const [dataSource] = useState<DataSource>(
    () => propDataSource || new ReplayDataSource(rawSessionsJsonl)
  );
  // The turn list, read again every few seconds while the service keeps a queue.
  const queueView = useQueue(queue);
  const refreshQueue = queueView?.refresh;

  // Every session from one snapshot, newest activity first. The Sessions
  // column lists all of them, whatever agent is selected: a session can use
  // many agents. null until the first list arrives.
  const [allSessions, setAllSessions] = useState<SessionSummary[] | null>(null);
  // The agent selected in the Agents column: "+ Session" starts on it. It
  // does not filter the sessions. null means nothing is selected; "" is a
  // real agent id: sessions no run started.
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // The session on screen, its turns and the turns whose events are loaded.
  // While switching, it stays the previous session until the new one's turns
  // arrive.
  const [shown, setShown] = useState<Shown | null>(null);
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
    setPanelOpen(true);
  };


  // The agents form: closed (null), or open for a new agent or on one to edit.
  const [agentsDialog, setAgentsDialog] = useState<{ edit?: SavedAgent } | null>(null);
  // The page on screen: the cockpit, /runners or /settings.
  const [page, goPage] = usePage();
  // The saved agents: the rows of the Agents column, the picker beside Send
  // and each turn's agent name. Read at the start, whenever the agents form
  // closes, and after a remove (agentsKey).
  const [savedAgents, setSavedAgents] = useState<SavedAgent[] | undefined>(undefined);
  const [agentsKey, setAgentsKey] = useState(0);
  const agents = useMemo(() => buildAgents(allSessions ?? [], savedAgents), [allSessions, savedAgents]);
  // The sessions the service said are closed when one was opened
  // (GET /api/v0/sessions/<id>), for a list that does not say it yet.
  const [closedIds, setClosedIds] = useState<ReadonlySet<string>>(() => new Set());
  const sessions = useMemo(
    () => (allSessions ?? []).map((s) => (!s.closed && closedIds.has(s.id) ? { ...s, closed: true } : s)),
    [allSessions, closedIds]
  );
  const loading = allSessions === null;
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
      .then((list) => {
        setShown((s) =>
          s && s.session.id === sessionId && isNewerList(s.cursor, list)
            ? { ...s, session: { ...s.session, turnsList: list.turns }, cursor: { store: list.store, seq: list.seq } }
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
  // event (session.closed). No event says the job ended, so the stream never
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
  const pageShown = ownPageShown(page, dataSource);
  const streamOn = tabShown && !pageShown;
  useEffect(() => {
    if (!dataSource.subscribe || !streamOn) return;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
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
  // otherwise take the first available: the newest session, and its agent.
  // Nothing is picked before the sessions are read: a saved agent listed
  // first would otherwise be kept, empty, once they arrive.
  useEffect(() => {
    if (allSessions === null) return;
    const newest = allSessions[0];
    setSelectedAgentId((cur) =>
      cur !== null && agents.some((a) => a.id === cur) ? cur : newest ? sessionGroup(newest) : (agents[0]?.id ?? null)
    );
  }, [agents]);
  useEffect(() => {
    if (selectedSessionId !== null && sessions.some((s) => s.id === selectedSessionId)) return;
    const next = sessions[0]?.id ?? null;
    if (selectedSessionId === null) setSelectedSessionId(next);
    else chooseSession(next);
  }, [sessions]);

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
  useEffect(() => {
    if (awaitedSession === null) return;
    const s = allSessions?.find((x) => x.id === awaitedSession);
    if (!s) return;
    chooseSession(s.id);
    setAwaitedSession(null);
  }, [allSessions, awaitedSession]);

  // The New session dialog: closed (null), or open with an agent to preselect.
  const [newSession, setNewSession] = useState<{ agent?: string } | null>(null);
  // The turn whose changes are open, from GET /api/v0/turns/<id>/diff.
  const [changesTurn, setChangesTurn] = useState<Turn | null>(null);
  const loadChanges = useCallback(
    () => dataSource.getTurnDiff!(changesTurn!.sessionId, changesTurn!.id),
    [dataSource, changesTurn]
  );
  const loadContext = useMemo(
    () => (dataSource.getCallContext ? (t: string, x: string, full: boolean) => dataSource.getCallContext!(t, x, full) : undefined),
    [dataSource]
  );
  const loadTurn = useCallback((sessionId: string, turnId: string) => dataSource.getTurn(sessionId, turnId), [dataSource]);
  const canStart = !!(dataSource.startRun && dataSource.listAgents);
  // The harnesses the service finds: the review picker and the agent form read them.
  const loadHarnesses = useCallback(() => dataSource.getHarnesses!(), [dataSource]);
  const loadSaved = useCallback(() => dataSource.listAgents!(), [dataSource]);
  const canKeepAgents = !!(dataSource.listAgents && dataSource.getHarnesses && dataSource.createAgent);
  // The Connect step of a subscription agent, where control keeps the
  // person's own subscriptions for their runners.
  const subscriptionApi = useMemo<SubscriptionApi | undefined>(
    () =>
      dataSource.listSubscriptions && dataSource.connectSubscription && dataSource.getConnect &&
      dataSource.connectInput && dataSource.subscriptionsOn
        ? {
            list: () => dataSource.listSubscriptions!(),
            connect: (h) => dataSource.connectSubscription!(h),
            get: (h) => dataSource.getConnect!(h),
            input: (h, line) => dataSource.connectInput!(h, line),
            turnOn: () => dataSource.subscriptionsOn!(),
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
    if (!dataSource.listAgents || agentsDialog !== null) return;
    let active = true;
    dataSource.listAgents().then(
      (list) => active && setSavedAgents(list),
      () => undefined
    );
    return () => {
      active = false;
    };
  }, [dataSource, agentsDialog, agentsKey]);
  // Removes a saved agent from its row, then lists the agents again. A
  // refusal throws the API's words for the row to show.
  // The runners, for the list at the foot of the Agents column.
  // The Settings page, when the source has every settings route.
  const settingsApi = useMemo<SettingsApi | undefined>(() => {
    const d = dataSource;
    if (!d.getSettings || !d.getPolicy || !d.putPolicy || !d.getInstructions || !d.putInstructions) return undefined;
    return {
      getSettings: () => d.getSettings!(),
      getPolicy: () => d.getPolicy!(),
      putPolicy: (p, etag) => d.putPolicy!(p, etag),
      getInstructions: () => d.getInstructions!(),
      putInstructions: (t, etag) => d.putInstructions!(t, etag),
    };
  }, [dataSource]);
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
    // machine picked, whose runner checks it. The session runs there.
    const at = req.folder_ref
      ? { folder_ref: req.folder_ref, connector: req.connector, isolate: true }
      : { folder: req.folder, ...(req.connector ? { connector: req.connector } : {}) };
    // POST /api/v0/turns names the turn at once, even while it waits for a
    // runner. With the queue, the session gets its own copy of the folder.
    const started = await dataSource.startRun!(queue ? { ...req, ...at, isolate: true } : { ...req, ...at });
    refreshQueue?.();
    if (req.folder) rememberFolder(req.folder, req.connector);
    if (req.connector) rememberMachine(req.connector);
    if (title && dataSource.renameSession) {
      // The session runs either way; a refused name leaves the first message as its title.
      dataSource
        .renameSession(started.session, title)
        .then(() => setListKey((k) => k + 1))
        .catch((err) => console.warn(`Naming session ${started.session} failed:`, err));
    }
    awaitTurn(gen, started);
    return started;
  };
  // A session with no first message is a draft here: an empty conversation
  // with the agent, folder and name. A session in AgentBus starts with its
  // first turn, so the draft becomes one when its first message is sent.
  const [draft, setDraft] = useState<{ id: number; req: RunRequest; title?: string; session?: string } | null>(null);
  const draftSeq = useRef(0);
  const startRun = async (req: RunRequest, title?: string) => {
    const gen = nextSend();
    if (req.prompt.trim() === '') {
      setAwaitedTurn(null);
      setAwaitedSession(null);
      setPanelOpen(false);
      setDraft({ id: ++draftSeq.current, req, title });
      setNewSession(null);
      return;
    }
    await launch(req, title, gen);
    setDraft(null);
    setNewSession(null);
  };
  // The draft's first message, once sent. A message sent after it goes to
  // the session that one opens, never to a second new session.
  const draftRun = useRef<{ id: number; started: Promise<Started> } | null>(null);
  const sendDraft = draft
    ? async (prompt: string, readOnly: boolean, agent: string | undefined, key: string): Promise<Started> => {
        const gen = nextSend();
        const id = draft.id;
        const first = draftRun.current?.id === id ? draftRun.current.started : null;
        if (first && dataSource.sendMessage) {
          const { session } = await first;
          const next = await dataSource.sendMessage(session, { prompt, read_only: readOnly, agent, idempotency_key: key });
          refreshQueue?.();
          return next;
        }
        const run = launch(
          { ...draft.req, agent: agent ?? draft.req.agent, prompt, read_only: readOnly, idempotency_key: key },
          draft.title,
          gen
        );
        draftRun.current = { id, started: run };
        let started: Started;
        try {
          started = await run;
        } catch (err) {
          // Refused: the next message tries a new session again.
          if (draftRun.current?.started === run) draftRun.current = null;
          throw err;
        }
        // The draft stays on screen, with its message, until its session is shown.
        setDraft((d) => (d && d.id === id ? { ...d, session: started.session } : d));
        return started;
      }
    : undefined;
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
  const shownSessionId = shownId;
  const onPending = useCallback(
    (update: PendingUpdate) => {
      if (!shownSessionId) return;
      setPendingBySession((m) => ({ ...m, [shownSessionId]: update(m[shownSessionId] ?? []) }));
    },
    [shownSessionId]
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
    ? async (prompt: string, readOnly: boolean, agent: string | undefined, key: string): Promise<Started | undefined> => {
        if (shownId === null) return undefined;
        const gen = nextSend();
        const from = shownId;
        const started = await dataSource.sendMessage!(from, { prompt, read_only: readOnly, agent, idempotency_key: key });
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

  // A review of a turn, asked by its id. It rejects with the API's words.
  const reviewTurn = queue
    ? async (turn: Turn, agent: string, model: string) => {
        await queue.review(turn.id, { agent, model: model || undefined });
        refreshQueue?.();
      }
    : undefined;
  // Fix on a failed review fills the message box of the session on screen.
  // The person edits it and sends it, so it runs as the session's next turn
  // turn, in its own copy of the folder.
  const [prefill, setPrefill] = useState<{ session: string; text: string } | null>(null);
  const fixFindings = queue && sendMessage ? (text: string) => shownId !== null && setPrefill({ session: shownId, text }) : undefined;
  // Stops a queued or running turn from the CI/CD tab, such as a review.
  const stopQueued = queue
    ? async (t: ApiTurn) => {
        await queue.stop(t.id);
        refreshQueue?.();
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
  // (its session.closed reads the turn list again). A 409 means it had ended
  // already: read the list again now. Any other refusal rejects with the
  // API's words, for the conversation to show.
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
      // Events streamed while the turns were in flight join their turn; one
      // that changed the list after its cursor reads the list again.
      const streamed = streamedRef.current ?? [];
      streamedRef.current = null;
      const cursor = { store: list.store, seq: list.seq };
      const row = allSessionsRef.current?.find((s) => s.id === sessionId) ?? emptyRow(sessionId);
      setShown({ session: { ...row, turnsList: list.turns }, cursor, details: mergeIntoDetails(details, streamed) });
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
    () => (shown ? shown.session.turnsList.map((t) => (shown.details[t.id] ? { ...t, detail: shown.details[t.id] } : t)) : []),
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
    ? { ...(shownRow ?? shown.session), turnsList: turns, closed: !!shownRow?.closed || closedIds.has(shown.session.id) || undefined }
    : null;

  // Ask whether the selected session is closed, each time it is read.
  useEffect(() => {
    if (selectedSessionId === null || !dataSource.sessionClosed) return;
    let active = true;
    const id = selectedSessionId;
    dataSource
      .sessionClosed(id)
      .then((closed) => {
        if (active && closed) setClosedIds((set) => (set.has(id) ? set : new Set(set).add(id)));
      })
      .catch((err) => console.warn(`Reading whether session ${id} is closed failed:`, err));
    return () => {
      active = false;
    };
  }, [dataSource, selectedSessionId, reloadKey]);

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
      if (!panelOpenRef.current) return;
      if (panelEscRef.current?.()) return;
      setPanelOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The pages of their own, each at its address. A source without the
  // page's routes shows the cockpit.
  if (pageShown && page === 'runners') {
    return (
      <RunnersPage
        runners={runners.runners}
        error={runners.error}
        pending={runners.pending}
        reload={runners.reload}
        actions={runnerActions}
        queue={queueView ? { turns: queueView.turns, error: queueView.error } : undefined}
        onBack={() => goPage('cockpit')}
      />
    );
  }
  if (pageShown && page === 'settings') {
    return (
      <SettingsPage
        api={settingsApi!}
        onBack={() => goPage('cockpit')}
        sandbox={loadRunners ? sandboxOffer(runners.runners, runners.error) : undefined}
      />
    );
  }

  if (loading) {
    return (
      <div id="app" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--ink3)' }}>Loading AgentBus Cockpit…</div>
      </div>
    );
  }

  return (
    <FoldersContext.Provider value={folders}>
    <div id="app" className={panelOpen ? 'panel' : 'nopanel'}>
      <AgentsColumn
        agents={agents}
        selectedAgentId={selectedAgentId}
        sourceLabel={sourceLabel}
        onDisconnect={onDisconnect}
        disconnectLabel={disconnectLabel}
        // Selecting an agent only marks it, for "+ Session": the session on
        // screen and the list stay.
        onSelectAgent={setSelectedAgentId}
        onAddAgent={canKeepAgents ? () => setAgentsDialog({}) : undefined}
        onEditAgent={canKeepAgents && dataSource.updateAgent ? (a) => a.saved && setAgentsDialog({ edit: a.saved }) : undefined}
        onRemoveAgent={canKeepAgents && dataSource.removeAgent ? removeAgent : undefined}
        onRunners={loadRunners ? () => goPage('runners') : undefined}
        runnersOnline={runnersOnline}
        version={version ? versionLabel(version) : undefined}
        onSettings={settingsApi ? () => goPage('settings') : undefined}
      />

      <SessionsColumn
        sessions={sessions}
        live={dataSource.subscribe ? liveTurns : undefined}
        selectedSessionId={draft ? null : selectedSessionId}
        onSelectSession={(sessId) => {
          setDraft(null);
          nextSend();
          setAwaitedTurn(null);
          setAwaitedSession(null);
          chooseSession(sessId);
        }}
        // New session starts on the selected agent when it is a saved one.
        onNewSession={canStart ? () => setNewSession({ agent: agents.find((a) => a.id === selectedAgentId)?.saved?.id }) : undefined}
        onRename={renameSession}
        empty={sessions.length === 0}
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
          selectedTurn={null}
          onSelectTurn={() => undefined}
          level="session"
          panelOpen={false}
          agentName={agents.find((x) => x.id === draft.req.agent)?.name}
          agents={savedAgents}
          defaultAgent={draft.req.agent}
          onRename={async (_id, t) => setDraft((d) => (d ? { ...d, title: t.trim() } : d))}
        />
      ) : sessionView ? (
        <ConvoColumn
          key={sessionView.id}
          session={sessionView}
          resumable={sessionView.resumable}
          closed={sessionView.closed}
          open={sessionView.open}
          onSend={sendMessage}
          queuedTurn={queuedTurn}
          keyed={!!dataSource.queuedTurn}
          pending={pendingBySession[sessionView.id] ?? NO_PENDING}
          onPending={onPending}
          onStop={stopTurn}
          stopping={stopping}
          live={dataSource.subscribe ? liveTurns[sessionView.id] : undefined}
          prefill={prefill}
          onPrefillTaken={() => setPrefill(null)}
          selectedTurn={selectedTurn}
          onSelectTurn={clickTurn}
          level={shownLevel}
          panelOpen={panelOpen}
          agentName={agents.find((x) => x.id === sessionView.agent)?.name}
          agents={savedAgents}
          onOpenSession={(id) => {
            // A session not listed yet is opened once its row arrives, as for
            // a session just started.
            const s = allSessions?.find((x) => x.id === id);
            nextSend();
            setAwaitedTurn(null);
            if (!s) {
              setAwaitedSession(id);
              return;
            }
            setAwaitedSession(null);
            chooseSession(id);
          }}
          onRename={renameSession}
          onChanges={dataSource.getTurnDiff ? setChangesTurn : undefined}
          commands={commandsBySession[sessionView.id]}
        />
      ) : (
        <main id="convo">
          <header id="c-head" className="colhead">
            <div className="colhead-title">{allSessions.length === 0 ? 'No sessions yet' : 'No session selected'}</div>
          </header>
          <div id="c-msgs" style={{ padding: '1.25rem' }}>
            <p className="dim">
              {allSessions.length === 0
                ? canStart
                  ? 'Start one with New session.'
                  : 'Sessions appear here when an agent runs through agentbus.'
                : 'Select a session from the list to view conversation.'}
            </p>
          </div>
        </main>
      )}

      <div className="panel-slot" hidden={!panelOpen}>
      <RightPanel
        turn={selectedTurn}
        totalTurns={turns.length}
        selection={selection}
        onSelectEvent={selectEvent}
        level={shownLevel}
        session={sessionView}
        sessionCostUsd={sessionView?.cost_usd}
        sessionCostComplete={sessionView?.cost_complete}
        agentName={agents.find((a) => a.id === sessionView?.agent)?.name}
        callId={selectedCallId}
        onLevel={(l) => (l === 'session' ? selectSessionLevel() : setLevel(l))}
        onSelectTurn={selectTurnLevel}
        onSelectCall={selectCall}
        onOpenEvent={openEvent}
        loadContext={loadContext}
        loadTurn={loadTurn}
        queue={queueView}
        onReview={reviewTurn}
        onStopQueued={stopQueued}
        onFix={fixFindings}
        loadAgents={dataSource.getHarnesses ? loadHarnesses : undefined}
        live={!!dataSource.subscribe}
        onClose={() => setPanelOpen(false)}
        escRef={panelEscRef}
      />
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
      {changesTurn && dataSource.getTurnDiff && (
        <ChangesDialog
          key={changesTurn.id}
          turnNumber={changesTurn.turnNumber}
          loadDiff={loadChanges}
          apply={dataSource.applyTurn ? () => dataSource.applyTurn!(changesTurn.id) : undefined}
          onClose={() => setChangesTurn(null)}
        />
      )}
      {agentsDialog && canKeepAgents && (
        <AgentsDialog
          loadHarnesses={loadHarnesses}
          createAgent={(f) => dataSource.createAgent!(f)}
          updateAgent={(id, f) => dataSource.updateAgent!(id, f)}
          subscriptions={subscriptionApi}
          edit={agentsDialog.edit}
          onClose={() => setAgentsDialog(null)}
        />
      )}
    </div>
    </FoldersContext.Provider>
  );
};

export default App;
