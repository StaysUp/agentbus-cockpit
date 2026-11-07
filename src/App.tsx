import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import rawSessionsJsonl from '../testdata/sessions-v0.jsonl?raw';
import { AgentsColumn } from './components/AgentsColumn';
import { ConvoColumn } from './components/ConvoColumn';
import { NewSessionDialog } from './components/NewSessionDialog';
import { RightPanel } from './components/RightPanel';
import { SessionsColumn } from './components/SessionsColumn';
import { rememberFolder } from './data/folders';
import { ReplayDataSource } from './data/ReplayDataSource';
import { applyList, countedIn, isNewerList, ListCursor, StreamedCost, streamedCost } from './data/sessionList';
import { addStreamedCost, addTurnEvents, buildAgents, createEmptyUsage, turnDetail } from './data/turns';
import {
  CockpitEvent,
  DataSource,
  EventSelection,
  Level,
  RunRequest,
  SessionDetail,
  SessionList,
  SessionSummary,
  Started,
  Turn,
  TurnDetail,
} from './types';

// The longest wait before the sessions are fetched again after an event.
const LIST_REFRESH_MS = 500;

// Kinds that change a session's summary (agent, folder, open) as the service
// computes it; on these, fetch the sessions again at once.
const SUMMARY_KINDS = new Set(['session.registered', 'session.opened', 'session.closed', 'events.dropped']);

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
}

export const App: React.FC<AppProps> = ({ dataSource: propDataSource, sourceLabel, onDisconnect, disconnectLabel }) => {
  const [dataSource] = useState<DataSource>(
    () => propDataSource || new ReplayDataSource(rawSessionsJsonl)
  );

  // Every session from one snapshot; agents and the Sessions column derive
  // from it. null until the first list arrives.
  const [allSessions, setAllSessions] = useState<SessionSummary[] | null>(null);
  // null means nothing is selected. "" is a real agent id: sessions no run
  // started.
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
  // Leaving the turn level drops the event selection, so coming back opens
  // the turn as it was rather than jumping to an old event.
  const selectSessionLevel = () => {
    setLevel('session');
    setSelection(null);
  };
  // One rule for every way a session gets picked (the list, an agent, a
  // session the cockpit started, or a pick made because the shown one left
  // the list): the pick selects the session level. Only the first pick on
  // load keeps the default, turn 1.
  const chooseSession = (sessionId: string | null, agentId?: string) => {
    if (agentId !== undefined) setSelectedAgentId(agentId);
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

  const agents = useMemo(() => buildAgents(allSessions ?? []), [allSessions]);
  const sessions = useMemo(
    () => (allSessions ?? []).filter((s) => selectedAgentId !== null && s.agent === selectedAgentId),
    [allSessions, selectedAgentId]
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

  // Every session id seen, so a new session refreshes the lists once.
  const knownSessionsRef = useRef<Set<string>>(new Set());
  for (const s of sessions) knownSessionsRef.current.add(s.id);

  // Follow new events for as long as the app is shown.
  useEffect(() => {
    if (!dataSource.subscribe) return;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = dataSource.subscribe(
      (event) => {
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
        setReloadKey((k) => k + 1);
      }
    );
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [dataSource]);

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
  // otherwise take the first available.
  useEffect(() => {
    setSelectedAgentId((cur) =>
      cur !== null && agents.some((a) => a.id === cur) ? cur : (agents[0]?.id ?? null)
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
    if (from === undefined) setAwaitedSession(started.id);
    setAwaitedTurn(started.turn ? { session: started.id, turn: started.turn } : null);
  };
  useEffect(() => {
    if (awaitedSession === null) return;
    const s = allSessions?.find((x) => x.id === awaitedSession);
    if (!s) return;
    chooseSession(s.id, s.agent);
    setAwaitedSession(null);
  }, [allSessions, awaitedSession]);

  // The New session dialog: closed (null), or open with an agent to preselect.
  const [newSession, setNewSession] = useState<{ agent?: string } | null>(null);
  const loadContext = useMemo(
    () => (dataSource.getCallContext ? (x: string, full: boolean) => dataSource.getCallContext!(x, full) : undefined),
    [dataSource]
  );
  const loadTurn = useCallback((sessionId: string, turnId: string) => dataSource.getTurn(sessionId, turnId), [dataSource]);
  const canStart = !!(dataSource.startRun && dataSource.getInstalledAgents);
  const loadAgents = useCallback(() => dataSource.getInstalledAgents!(), [dataSource]);
  const startRun = async (req: RunRequest) => {
    const gen = nextSend();
    const started = await dataSource.startRun!(req);
    rememberFolder(req.folder);
    setNewSession(null);
    awaitTurn(gen, started);
  };
  // Everything the conversation and the panel show comes from the session on
  // screen. While switching, that is still the previous session until the
  // new one's turns load, so never the newly selected row.
  const shownId = shown?.session.id ?? null;
  const shownRow = shownId === null ? undefined : allSessions?.find((s) => s.id === shownId);
  const sendMessage = dataSource.sendMessage
    ? async (prompt: string, readOnly: boolean) => {
        if (shownId === null) return;
        const gen = nextSend();
        const from = shownId;
        awaitTurn(gen, await dataSource.sendMessage!(from, { prompt, read_only: readOnly }), from);
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
  // The session as the screens see it: its latest row and its turns.
  const sessionView: SessionDetail | null = shown ? { ...(shownRow ?? shown.session), turnsList: turns } : null;

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
  const shownLevelRef = useRef(shownLevel);
  shownLevelRef.current = shownLevel;
  const dialogOpenRef = useRef(false);
  dialogOpenRef.current = newSession !== null;

  // Esc first leaves a focused text box, then steps up one level: from a
  // call to its turn, then from the turn to the session.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || dialogOpenRef.current) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) {
        t.blur();
        return;
      }
      const cur = shownLevelRef.current;
      if (cur === 'call') setLevel('turn');
      else if (cur === 'turn') selectSessionLevel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (loading) {
    return (
      <div id="app" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--ink3)' }}>Loading AgentBus Cockpit…</div>
      </div>
    );
  }

  return (
    <div id="app">
      <AgentsColumn
        agents={agents}
        selectedAgentId={selectedAgentId}
        sourceLabel={sourceLabel}
        onDisconnect={onDisconnect}
        disconnectLabel={disconnectLabel}
        onSelectAgent={(agentId) => {
          // The session follows from the agent (the effect above picks its
          // first session); the level is the session's either way.
          nextSend();
          setAwaitedTurn(null);
          setAwaitedSession(null);
          setSelectedAgentId(agentId);
          selectSessionLevel();
        }}
        loadAgents={canStart ? loadAgents : undefined}
        onStartWith={(agent) => setNewSession({ agent })}
      />

      <SessionsColumn
        sessions={sessions}
        selectedSessionId={selectedSessionId}
        onSelectSession={(sessId) => {
          nextSend();
          setAwaitedTurn(null);
          setAwaitedSession(null);
          chooseSession(sessId);
        }}
        onNewSession={canStart ? () => setNewSession({}) : undefined}
        empty={allSessions.length === 0}
      />

      {sessionView ? (
        <ConvoColumn
          key={sessionView.id}
          session={sessionView}
          costUsd={sessionView.cost_usd}
          costComplete={sessionView.cost_complete}
          resumable={sessionView.resumable}
          open={sessionView.open}
          onSend={sendMessage}
          selectedTurn={selectedTurn}
          onSelectTurn={selectTurnLevel}
          onSelectEvent={selectEvent}
          level={shownLevel}
          selectedCallId={selectedCallId}
          onSelectSession={selectSessionLevel}
          onSelectCall={selectCall}
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
      />

      {newSession && canStart && (
        <NewSessionDialog
          loadAgents={loadAgents}
          onStart={startRun}
          onClose={() => setNewSession(null)}
          initialAgent={newSession.agent}
        />
      )}
    </div>
  );
};

export default App;
