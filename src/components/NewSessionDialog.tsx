import React, { useEffect, useMemo, useState } from 'react';
import { FolderInfo, byRecentUse, lastMachine, recentFolders } from '../data/folders';
import { Harness, RunRequest, RunnerInfo, SavedAgent } from '../types';
import { agentLine } from './AgentsDialog';
import { Button, Select } from './Controls';
import { Dialog, DialogActions } from './Dialog';
import { Notice, WithCode } from './Notice';
import { LOADING, PRODUCT, SESSION } from '../words';

interface NewSessionDialogProps {
  // The saved agents (GET /api/v0/agents).
  loadAgents: () => Promise<SavedAgent[]>;
  // The harnesses, to say which agents cannot start here. Optional.
  loadHarnesses?: () => Promise<Harness[]>;
  // Starts the session, with its name when one is given. An empty prompt
  // opens the conversation empty, for its first message. Rejects with the
  // API's message when the run is refused.
  onStart: (req: RunRequest, title?: string) => Promise<void>;
  onClose: () => void;
  initialAgent?: string;
  // Opens the agents dialog, to add one.
  onAddAgent?: () => void;
  // The folders the service lists (GET /api/v0/folders), by reference, each
  // with its machine.
  folders?: FolderInfo[];
  // The machines, one runner each (GET /api/v0/runners). A session runs on
  // the machine picked, in a folder on it. Empty or absent: a service that
  // names no machine, where the folder is a path on the one AgentBus runs on.
  machines?: RunnerInfo[];
}

// A refused typed folder, in plain words. The service's own text is written
// for programs (it names fields and endpoints), so the dialog says what the
// person can do instead. Any other refusal shows the service's words.
export function folderRefusal(message: string): string | null {
  if (/not an existing directory|absolute path|no such file|does not exist/i.test(message)) return 'That folder does not exist.';
  if (/machine is offline|machine .* is offline|no machine is online/i.test(message))
    return 'That machine is offline. Run `agentbus runner` on it, or pick another machine.';
  if (/has no folders of its own|folder_ref|connector is not connected|machines are online/i.test(message))
    return 'This service cannot use that folder. Pick one of the folders listed under the field.';
  return null;
}

// The folder a new session starts in: a listed folder by its reference, or
// a path typed for the machine picked.
type Where = { ref: string; machine?: string } | { path: string };

// A new session is a saved agent and a folder, with an optional name and an
// optional first message. The service isolates it: the session works on its own copy of the folder,
// and nothing reaches the folder until a turn's changes are applied.
export const NewSessionDialog: React.FC<NewSessionDialogProps> = ({
  loadAgents,
  loadHarnesses,
  onStart,
  onClose,
  initialAgent,
  onAddAgent,
  folders: allFolders = [],
  machines = [],
}) => {
  const [agents, setAgents] = useState<SavedAgent[] | null>(null);
  const [harnesses, setHarnesses] = useState<Harness[] | undefined>(undefined);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agent, setAgent] = useState(initialAgent ?? '');
  // The machines a session can start on: each runner that reports its
  // machine. A connector from before 0.5 takes no work.
  const usable = machines.filter((m) => m.role !== 'connector' && !!m.machine);
  const byMachine = usable.length > 0;
  // The machine: the one used last while it is online, else the first online
  // one. Picked once, when the list first has one, unless the person chose.
  const firstMachine = (list: RunnerInfo[]) => {
    const on = list.filter((m) => m.online);
    const last = lastMachine();
    return (on.find((m) => m.machine === last) ?? on[0])?.machine ?? '';
  };
  const [machine, setMachine] = useState(() => firstMachine(usable));
  const [machineTouched, setMachineTouched] = useState(false);
  useEffect(() => {
    if (machineTouched || machine !== '') return;
    const m = firstMachine(usable);
    if (m) setMachine(m);
    // usable is derived from machines each render.
  }, [machines, machineTouched, machine]);
  const picked = usable.find((m) => m.machine === machine);
  // Every listed folder, on whichever machine holds it, recently used first;
  // the recent paths are the machine picked's (all of them on a service that
  // names no machine). At most five recent paths, newest first (recentFolders
  // keeps no more).
  const folderKey = allFolders.map((f) => f.ref).join(',');
  const folders = useMemo(() => byRecentUse(allFolders), [folderKey]);
  const recent = useMemo(() => recentFolders(byMachine ? machine : undefined), [byMachine, machine]);
  // A listed folder names its machine when there is more than one to start on.
  const machineOf = (f: FolderInfo) => usable.find((m) => m.machine === f.machine);
  const nameMachines = byMachine && usable.length > 1;
  // No folder is picked for the person: the session runs where they say,
  // so Start waits for a listed folder, a recent one or a typed path. A
  // listed folder that leaves the list is dropped.
  const [where, setWhere] = useState<Where | null>(null);
  useEffect(() => {
    setWhere((cur) => (cur && 'ref' in cur && !allFolders.some((f) => f.ref === cur.ref) ? null : cur));
    // allFolders is a new array each render; its references are the key.
  }, [folderKey]);
  const pick = (w: Where) => setWhere(w);
  // A listed folder runs where it is: picking one on another machine picks
  // that machine too.
  const pickFolder = (f: FolderInfo) => {
    if (byMachine && f.machine && f.machine !== machine) {
      setMachineTouched(true);
      setMachine(f.machine);
    }
    pick({ ref: f.ref, machine: f.machine });
  };
  // Another machine holds other folders: a typed path, or a listed folder of
  // the machine left, is picked again.
  const pickMachine = (m: string) => {
    setMachineTouched(true);
    if (m !== machine) setWhere((cur) => (cur && 'ref' in cur && cur.machine === m ? cur : null));
    setMachine(m);
  };
  const path = where && 'path' in where ? where.path : '';
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [starting, setStarting] = useState(false);
  // Start was pressed with something missing: the missing field says so.
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An agent whose harness the service does not find cannot start here. With
  // no harness list, every agent can be picked; the service says why not.
  const found = (a: SavedAgent) => !harnesses || harnesses.some((h) => h.name === a.harness && h.found);

  useEffect(() => {
    let active = true;
    Promise.all([loadAgents(), loadHarnesses ? loadHarnesses().catch(() => undefined) : Promise.resolve(undefined)]).then(
      ([list, hs]) => {
        if (!active) return;
        setAgents(list);
        setHarnesses(hs);
        const ok = (a: SavedAgent) => !hs || hs.some((h) => h.name === a.harness && h.found);
        setAgent((cur) => (list.some((a) => a.id === cur && ok(a)) ? cur : (list.find(ok)?.id ?? '')));
      },
      (err: Error) => active && setAgentsError(err.message)
    );
    return () => {
      active = false;
    };
  }, [loadAgents, loadHarnesses]);

  const chosen = agents?.find((a) => a.id === agent);
  const hasWhere = !!where && ('ref' in where || where.path.trim() !== '');
  const machineOk = !byMachine || (!!picked && picked.online);
  const ready = agent !== '' && hasWhere && machineOk && !starting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) {
      setTried(true);
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const at =
        'ref' in where!
          ? { folder_ref: where!.ref, machine: where!.machine }
          : { folder: where!.path.trim(), ...(byMachine ? { machine: machine } : {}) };
      await onStart({ agent, ...at, prompt: prompt.trim() === '' ? '' : prompt }, name.trim() || undefined);
    } catch (err) {
      const msg = (err as Error).message;
      setError(('path' in where! && folderRefusal(msg)) || msg);
      setStarting(false);
    }
  };

  return (
    <Dialog title={`New ${SESSION}`} onClose={onClose} busy={starting} onSubmit={submit}>
        <label>
          <span>Agent</span>
          <Select
            name="agent"
            label="Agent"
            value={agent}
            disabled={!agents}
            placeholder={agents ? 'No agents' : agentsError ? '' : LOADING}
            options={(agents ?? []).map((a) => ({
              value: a.id,
              label: a.name,
              hint: found(a) ? undefined : 'not installed',
              disabled: !found(a),
            }))}
            onChange={setAgent}
          />
        </label>
        {chosen && <div className="nd-note">{agentLine(chosen, harnesses)}</div>}
        {agentsError && <Notice kind="error">{agentsError}</Notice>}
        {agents && agents.length === 0 && (
          <div className="nd-note">
            No agents yet.{' '}
            {onAddAgent && (
              <Button kind="link" className="nd-link" onClick={onAddAgent}>
                Add one
              </Button>
            )}
          </div>
        )}
        {byMachine && (
          <label>
            <span>Machine</span>
            <Select
              name="machine"
              label="Machine"
              value={picked ? machine : ''}
              placeholder="Pick a machine"
              options={usable.map((m) => ({
                value: m.machine!,
                label: m.name,
                hint: m.online ? undefined : 'offline',
                disabled: !m.online,
              }))}
              onChange={pickMachine}
            />
          </label>
        )}
        {byMachine && !usable.some((m) => m.online) && (
          <div className="nd-note">
            No machine is online. Run <code>agentbus runner</code> on one.
          </div>
        )}
        <label>
          <span>Folder</span>
          <input
            name="folder"
            type="text"
            aria-invalid={tried && !hasWhere ? true : undefined}
            className={tried && !hasWhere ? 'invalid' : undefined}
            value={path}
            onChange={(e) => pick({ path: e.target.value })}
            placeholder={folders.length > 0 || recent.length > 0 ? 'Pick one below, or type a path' : 'Path to a folder'}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        {(folders.length > 0 || recent.length > 0) && (
          <div className="nd-recent">
            {folders.map((f) => {
              const on = machineOf(f);
              // A folder on a machine that is offline, or not one a session
              // can start on, cannot be picked.
              const off = byMachine && (!on || !on.online);
              return (
                <button
                  type="button"
                  key={f.ref}
                  className={`pick${where && 'ref' in where && where.ref === f.ref ? ' on' : ''}`}
                  title={f.ref}
                  disabled={off}
                  onClick={() => pickFolder(f)}
                >
                  <code>{f.name || f.ref}</code>
                  {nameMachines && (
                    <span className="nd-machine">
                      {on ? on.name : f.machine}
                      {off ? ' · offline' : ''}
                    </span>
                  )}
                </button>
              );
            })}
            {recent.map((f) => (
              <button type="button" key={f} className={`pick${f === path ? ' on' : ''}`} onClick={() => pick({ path: f })}>
                <code>{f}</code>
              </button>
            ))}
          </div>
        )}
        {!hasWhere && tried && (
          <Notice kind="error" className="nd-missing">
            Pick a folder to start.
          </Notice>
        )}
        <div className="nd-note">
          {byMachine ? `A folder on ${picked?.name ?? 'the machine picked'}. ` : `A folder on the machine ${PRODUCT} runs on. `}
          The {SESSION} works on a copy until you apply its changes.
        </div>
        <label>
          <span>Name (optional)</span>
          <input
            name="name"
            type="text"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            placeholder="From the first message"
            autoComplete="off"
          />
        </label>
        <label>
          <span>First message (optional)</span>
          <textarea name="prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        {prompt.trim() === '' && <div className="nd-note">Empty: write it in the {SESSION}.</div>}
        {error && (
          <Notice kind="error">
            <WithCode text={error} />
          </Notice>
        )}
        <DialogActions>
          <Button kind="primary" type="submit" className="nd-start" disabled={starting || !agents || !machineOk}>
            {starting ? 'Starting…' : 'Start'}
          </Button>
        </DialogActions>
    </Dialog>
  );
};
