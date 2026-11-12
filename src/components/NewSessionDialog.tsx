import React, { useEffect, useMemo, useState } from 'react';
import { FolderInfo, lastMachine, recentFolders } from '../data/folders';
import { Harness, RunRequest, RunnerInfo, SavedAgent } from '../types';
import { agentLine } from './AgentsDialog';
import { Select } from './Controls';

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
    return 'That machine is offline. Start agentbus runner on it, or pick another machine.';
  if (/has no folders of its own|folder_ref|connector is not connected|machines are online/i.test(message))
    return 'This service cannot use that folder. Pick one of the folders listed under the field.';
  return null;
}

// The folder a new session starts in: a listed folder by its reference, or
// a path typed for the machine picked.
type Where = { ref: string; connector?: string } | { path: string };

// A new session is a saved agent and a folder, with an optional name and an
// optional first message. The service isolates it: the conversation works on its own copy of the folder,
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
  const usable = machines.filter((m) => m.role !== 'connector' && !!m.connector);
  const byMachine = usable.length > 0;
  // The machine: the one used last while it is online, else the first online
  // one. Picked once, when the list first has one, unless the person chose.
  const firstMachine = (list: RunnerInfo[]) => {
    const on = list.filter((m) => m.online);
    const last = lastMachine();
    return (on.find((m) => m.connector === last) ?? on[0])?.connector ?? '';
  };
  const [machine, setMachine] = useState(() => firstMachine(usable));
  const [machineTouched, setMachineTouched] = useState(false);
  useEffect(() => {
    if (machineTouched || machine !== '') return;
    const m = firstMachine(usable);
    if (m) setMachine(m);
    // usable is derived from machines each render.
  }, [machines, machineTouched, machine]);
  const picked = usable.find((m) => m.connector === machine);
  // The listed folders and the recent paths of the machine picked; all of
  // them on a service that names no machine. At most five recent paths,
  // newest first (recentFolders keeps no more).
  const folders = byMachine ? allFolders.filter((f) => f.connector === machine) : allFolders;
  const recent = useMemo(() => recentFolders(byMachine ? machine : undefined), [byMachine, machine]);
  // No folder is picked for the person: the session runs where they say,
  // so Start waits for a listed folder, a recent one or a typed path. A
  // listed folder that leaves the list is dropped.
  const [where, setWhere] = useState<Where | null>(null);
  const folderKey = folders.map((f) => f.ref).join(',');
  useEffect(() => {
    setWhere((cur) => (cur && 'ref' in cur && !folders.some((f) => f.ref === cur.ref) ? null : cur));
    // folders is derived from allFolders and machine each render.
  }, [folderKey]);
  const pick = (w: Where) => setWhere(w);
  // Another machine holds other folders: the folder is picked again.
  const pickMachine = (m: string) => {
    setMachineTouched(true);
    if (m !== machine) setWhere(null);
    setMachine(m);
  };
  const path = where && 'path' in where ? where.path : '';
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [starting, setStarting] = useState(false);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const chosen = agents?.find((a) => a.id === agent);
  const hasWhere = !!where && ('ref' in where || where.path.trim() !== '');
  const machineOk = !byMachine || (!!picked && picked.online);
  const ready = agent !== '' && hasWhere && machineOk && !starting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setStarting(true);
    setError(null);
    try {
      const at =
        'ref' in where!
          ? { folder_ref: where!.ref, connector: where!.connector }
          : { folder: where!.path.trim(), ...(byMachine ? { connector: machine } : {}) };
      await onStart({ agent, ...at, prompt: prompt.trim() === '' ? '' : prompt }, name.trim() || undefined);
    } catch (err) {
      const msg = (err as Error).message;
      setError(('path' in where! && folderRefusal(msg)) || msg);
      setStarting(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="new-dialog" onSubmit={submit}>
        <div className="nd-title">New session</div>
        <label>
          <span>Agent</span>
          <Select
            name="agent"
            label="Agent"
            value={agent}
            disabled={!agents}
            placeholder={agents ? 'No agents' : agentsError ? '' : 'Looking…'}
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
        {agentsError && <div className="form-error">{agentsError}</div>}
        {agents && agents.length === 0 && (
          <div className="nd-note">
            No agents yet.{' '}
            {onAddAgent && (
              <button type="button" className="nd-link" onClick={onAddAgent}>
                Add one
              </button>
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
                value: m.connector!,
                label: m.name,
                hint: m.online ? undefined : 'offline',
                disabled: !m.online,
              }))}
              onChange={pickMachine}
            />
          </label>
        )}
        {byMachine && !usable.some((m) => m.online) && (
          <div className="nd-note">No machine is online. Start agentbus runner on one.</div>
        )}
        <label>
          <span>Folder</span>
          <input
            name="folder"
            type="text"
            value={path}
            onChange={(e) => pick({ path: e.target.value })}
            placeholder={folders.length > 0 || recent.length > 0 ? 'Pick one below, or type a path' : '/Users/you/project'}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        {(folders.length > 0 || recent.length > 0) && (
          <div className="nd-recent">
            {folders.map((f) => (
              <button
                type="button"
                key={f.ref}
                className={where && 'ref' in where && where.ref === f.ref ? 'on' : ''}
                title={f.ref}
                onClick={() => pick({ ref: f.ref, connector: f.connector })}
              >
                <code>{f.name || f.ref}</code>
              </button>
            ))}
            {recent.map((f) => (
              <button type="button" key={f} className={f === path ? 'on' : ''} onClick={() => pick({ path: f })}>
                <code>{f}</code>
              </button>
            ))}
          </div>
        )}
        {!hasWhere && (folders.length > 0 || recent.length > 0) && <div className="nd-note">Pick a folder to start.</div>}
        <div className="nd-note">
          {byMachine
            ? `A folder on ${picked?.name ?? 'the machine picked'}: pick a recent one or type its path. The session runs on that machine. `
            : folders.length > 0
              ? 'A folder the service lists, or a path on the machine where AgentBus runs. '
              : 'A folder on the machine where AgentBus runs. '}
          The conversation works on its own copy of it, so your folder is not changed until you apply a turn's changes.
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
        {prompt.trim() === '' && <div className="nd-note">Leave it empty to write it in the conversation.</div>}
        {error && <div className="form-error">{error}</div>}
        <div className="nd-actions">
          <button type="submit" className="connect-go" disabled={!ready}>
            {starting ? 'Starting…' : 'Start'}
          </button>
          <button type="button" className="use-recorded" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
};
