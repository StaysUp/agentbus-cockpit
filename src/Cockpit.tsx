import React, { useEffect, useMemo, useRef, useState } from 'react';
import { App } from './App';
import { ConnectScreen } from './components/ConnectScreen';
import {
  checkConnection,
  clearSaved,
  Connection,
  DEFAULT_ADDRESS,
  exchangeSignInCode,
  loadSaved,
  normalizeAddress,
  Saved,
  saveConnection,
  saveReplay,
  servedByAgentbus,
  takeSignInCode,
  wantsRecorded,
} from './data/connection';
import { LiveDataSource } from './data/LiveDataSource';
import { probeQueue, TurnsClient } from './data/jobs';
import { ReplayDataSource } from './data/ReplayDataSource';
import rawSessionsJsonl from '../testdata/sessions-v0.jsonl?raw';

// The sign-in link's code, taken from the address bar once per page load:
// React may run an initializer twice, and the code works only once.
// Its trade is kept too, so an effect React runs twice sends it once.
let pendingCode: { code: string | null } | null = null;
let trade: Promise<{ token: string } | { error: string }> | null = null;
function signInCode(): string | null {
  if (!servedByAgentbus()) return null;
  if (pendingCode === null) pendingCode = { code: takeSignInCode() };
  return pendingCode.code;
}
function tradeOnce(origin: string, code: string) {
  if (trade === null) trade = exchangeSignInCode(origin, code);
  return trade;
}

// For tests: forget the code taken and its trade.
export function resetSignInCode(): void {
  pendingCode = null;
  trade = null;
}

// Chooses the data source: the live client API after a checked connect, or
// the recorded sessions when the address asks for them with ?recorded (for
// development and tests; nothing on screen leads there). The app itself
// never knows which.
//
// Served by agentbus itself, the API is this page's own origin: the sign-in
// link's code connects without the connect screen, and the screen, when it
// shows, offers that address. From the dev server it works as before.
export const Cockpit: React.FC = () => {
  const served = useMemo(() => servedByAgentbus(), []);
  const recorded = useMemo(() => wantsRecorded(), []);
  const code = useMemo(() => (recorded ? null : signInCode()), []);
  const [saved, setSaved] = useState<Saved>(() => {
    if (recorded) {
      saveReplay();
      return { mode: 'replay' };
    }
    return code ? null : loadSaved();
  });
  // A connection kept from earlier in this tab is checked again before use;
  // a sign-in code is traded and checked.
  const [checking, setChecking] = useState(() => saved?.mode === 'live' || code !== null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState(() =>
    saved?.mode === 'live' ? saved.connection.address : served ? window.location.origin : DEFAULT_ADDRESS
  );

  const live = saved?.mode === 'live' && !checking ? saved.connection : null;
  // Whether the service keeps a turn queue: agentbus up and agentbus server
  // do; a runner's own service does not. Read once per connect.
  const [hasQueue, setHasQueue] = useState(false);
  const dataSource = useMemo(() => {
    if (saved?.mode === 'replay') return new ReplayDataSource(rawSessionsJsonl);
    if (live) return new LiveDataSource({ baseUrl: live.address, token: live.token });
    return null;
  }, [saved, live]);
  const queue = useMemo(() => (live && hasQueue ? new TurnsClient(live.address, live.token) : undefined), [live, hasQueue]);

  // Each check gets an id. Any mode change (disconnect, a new connect) takes a new id, so the result of an older check is ignored.
  const checkId = useRef(0);
  const startCheck = () => ++checkId.current;
  const cancelChecks = () => {
    checkId.current++;
    setChecking(false);
  };

  useEffect(() => {
    if (code === null) return;
    const id = startCheck();
    const origin = window.location.origin;
    tradeOnce(origin, code).then(async (got) => {
      if (id !== checkId.current) return;
      if ('error' in got) {
        setChecking(false);
        setError(got.error);
        return;
      }
      const c: Connection = { address: origin, token: got.token };
      const { problem, queue } = await checkAll(c);
      if (id !== checkId.current) return;
      setHasQueue(queue);
      setChecking(false);
      if (problem) {
        setError(problem);
        return;
      }
      saveConnection(c);
      setSaved({ mode: 'live', connection: c });
    });
    return () => {
      if (id === checkId.current) checkId.current++;
    };
    // Once per page load: the code works once.
  }, []);

  useEffect(() => {
    if (saved?.mode !== 'live' || !checking) return;
    const id = startCheck();
    checkAll(saved.connection).then(({ problem, queue }) => {
      if (id !== checkId.current) return;
      setHasQueue(queue);
      setChecking(false);
      if (problem) {
        clearSaved();
        setSaved(null);
        setError(problem);
      }
    });
    return () => {
      if (id === checkId.current) checkId.current++;
    };
    // Only the first check on load runs here; connect() does its own.
  }, []);

  const connect = async (rawAddress: string, token: string) => {
    const c: Connection = { address: normalizeAddress(rawAddress), token };
    const id = startCheck();
    setChecking(true);
    setError(null);
    const { problem, queue } = await checkAll(c);
    if (id !== checkId.current) return;
    setHasQueue(queue);
    setChecking(false);
    if (problem) {
      setError(problem);
      return;
    }
    saveConnection(c);
    setSaved({ mode: 'live', connection: c });
  };

  const disconnect = () => {
    cancelChecks();
    clearSaved();
    setSaved(null);
    setError(null);
  };

  // A label for the foot of the Agents column.
  const label = live ? `agentbus at ${live.address.replace(/^https?:\/\//, '')}` : 'Recorded data';

  if (!dataSource) {
    return (
      <ConnectScreen
        address={address}
        onAddressChange={setAddress}
        checking={checking}
        error={error}
        onConnect={connect}
        served={served}
      />
    );
  }

  return (
    <App
      key={live ? `${live.address}\n${live.token}\n${hasQueue}` : 'replay'}
      dataSource={dataSource}
      queue={queue}
      sourceLabel={label}
      onDisconnect={disconnect}
      disconnectLabel={live ? 'Disconnect' : 'Connect'}
    />
  );
};

// The service first, then whether it keeps a turn queue. problem is the
// first problem found, or null.
async function checkAll(c: Connection): Promise<{ problem: string | null; queue: boolean }> {
  const problem = await checkConnection(c, window.location.origin);
  if (problem) return { problem, queue: false };
  return { problem: null, queue: await probeQueue(c.address, c.token) };
}

export default Cockpit;
