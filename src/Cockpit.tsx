import React, { useEffect, useMemo, useRef, useState } from 'react';
import { App } from './App';
import { ConnectScreen } from './components/ConnectScreen';
import {
  checkConnection,
  clearSaved,
  Connection,
  DEFAULT_ADDRESS,
  loadSaved,
  normalizeAddress,
  Saved,
  saveConnection,
  saveReplay,
} from './data/connection';
import { LiveDataSource } from './data/LiveDataSource';
import { probeQueue, TurnsClient } from './data/jobs';
import { ReplayDataSource } from './data/ReplayDataSource';
import rawSessionsJsonl from '../testdata/sessions-v0.jsonl?raw';

// Chooses the data source: the live client API after a checked connect, or
// the recorded sessions for demos. The app itself never knows which.
export const Cockpit: React.FC = () => {
  const [saved, setSaved] = useState<Saved>(() => loadSaved());
  // A connection kept from earlier in this tab is checked again before use.
  const [checking, setChecking] = useState(() => saved?.mode === 'live');
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState(() =>
    saved?.mode === 'live' ? saved.connection.address : DEFAULT_ADDRESS
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

  // Each check gets an id. Any mode change (recorded data, disconnect, a new
  // connect) takes a new id, so the result of an older check is ignored.
  const checkId = useRef(0);
  const startCheck = () => ++checkId.current;
  const cancelChecks = () => {
    checkId.current++;
    setChecking(false);
  };

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

  const useRecorded = () => {
    cancelChecks();
    setError(null);
    saveReplay();
    setSaved({ mode: 'replay' });
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
        onUseRecorded={useRecorded}
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
