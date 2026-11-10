import React, { useEffect, useState } from 'react';
import { FolderInfo, recentFolders } from '../data/folders';
import { Harness, RunRequest, SavedAgent } from '../types';
import { agentLine } from './AgentsDialog';

interface NewSessionDialogProps {
  // The saved agents (GET /api/v0/agents).
  loadAgents: () => Promise<SavedAgent[]>;
  // The harnesses, to say which agents cannot start here. Optional.
  loadHarnesses?: () => Promise<Harness[]>;
  // Rejects with the API's message when the run is refused.
  onStart: (req: RunRequest) => Promise<void>;
  onClose: () => void;
  initialAgent?: string;
  // Opens the agents dialog, to add one.
  onAddAgent?: () => void;
  // The folders the service lists (GET /api/v0/folders), by reference. On
  // agentbus server they are the only folders a session can start in.
  folders?: FolderInfo[];
}

// The folder a new session starts in: a listed folder by its reference, or
// a path on the machine where AgentBus runs (agentbus up).
type Where = { ref: string; connector?: string } | { path: string };

// A new session is a saved agent and a folder, with a first message. The
// service isolates it: the conversation works on its own copy of the folder,
// and nothing reaches the folder until a turn's changes are applied.
export const NewSessionDialog: React.FC<NewSessionDialogProps> = ({ loadAgents, loadHarnesses, onStart, onClose, initialAgent, onAddAgent, folders = [] }) => {
  const [agents, setAgents] = useState<SavedAgent[] | null>(null);
  const [harnesses, setHarnesses] = useState<Harness[] | undefined>(undefined);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agent, setAgent] = useState(initialAgent ?? '');
  const [recent] = useState(() => recentFolders());
  // A listed folder first, as the service knows it; else the last path.
  // Picked once, when the list first has one, unless the person chose.
  const [where, setWhere] = useState<Where | null>(() =>
    folders[0] ? { ref: folders[0].ref, connector: folders[0].connector } : recent[0] ? { path: recent[0] } : null
  );
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched || folders.length === 0) return;
    setWhere((cur) => (cur && 'ref' in cur ? cur : { ref: folders[0].ref, connector: folders[0].connector }));
  }, [folders, touched]);
  const pick = (w: Where) => {
    setTouched(true);
    setWhere(w);
  };
  const path = where && 'path' in where ? where.path : '';
  const [prompt, setPrompt] = useState('');
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
  const ready = agent !== '' && hasWhere && prompt.trim() !== '' && !starting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setStarting(true);
    setError(null);
    try {
      const at = 'ref' in where! ? { folder_ref: where!.ref, connector: where!.connector } : { folder: where!.path.trim() };
      await onStart({ agent, ...at, prompt });
    } catch (err) {
      setError((err as Error).message);
      setStarting(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="new-dialog" onSubmit={submit}>
        <div className="nd-title">New session</div>
        <label>
          <span>Agent</span>
          <select name="agent" value={agent} onChange={(e) => setAgent(e.target.value)} disabled={!agents}>
            {!agents && <option value="">{agentsError ? '' : 'Looking…'}</option>}
            {agents?.map((a) => (
              <option key={a.id} value={a.id} disabled={!found(a)}>
                {found(a) ? a.name : `${a.name} (not installed)`}
              </option>
            ))}
          </select>
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
        <label>
          <span>Folder</span>
          <input
            name="folder"
            type="text"
            value={path}
            onChange={(e) => pick({ path: e.target.value })}
            placeholder={folders.length > 0 ? 'or a path on this machine' : '/Users/you/project'}
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
        <div className="nd-note">
          {folders.length > 0
            ? 'A folder the service lists, or a path on the machine where AgentBus runs. '
            : 'A folder on the machine where AgentBus runs. '}
          The conversation works on its own copy of it, so your folder is not changed until you apply a turn's changes.
        </div>
        <label>
          <span>First message</span>
          <textarea name="prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
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
