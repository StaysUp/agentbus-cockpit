import React, { useEffect, useState } from 'react';
import { recentFolders } from '../data/folders';
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
}

// A new session is a saved agent and a folder, with a first message. The
// service isolates it: the conversation works on its own copy of the folder,
// and nothing reaches the folder until a turn's changes are applied.
export const NewSessionDialog: React.FC<NewSessionDialogProps> = ({ loadAgents, loadHarnesses, onStart, onClose, initialAgent, onAddAgent }) => {
  const [agents, setAgents] = useState<SavedAgent[] | null>(null);
  const [harnesses, setHarnesses] = useState<Harness[] | undefined>(undefined);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agent, setAgent] = useState(initialAgent ?? '');
  const [recent] = useState(() => recentFolders());
  const [folder, setFolder] = useState(() => recent[0] ?? '');
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
  const ready = agent !== '' && folder.trim() !== '' && prompt.trim() !== '' && !starting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setStarting(true);
    setError(null);
    try {
      await onStart({ agent, folder: folder.trim(), prompt });
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
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="/Users/you/project"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        {recent.length > 0 && (
          <div className="nd-recent">
            {recent.map((f) => (
              <button type="button" key={f} className={f === folder ? 'on' : ''} onClick={() => setFolder(f)}>
                <code>{f}</code>
              </button>
            ))}
          </div>
        )}
        <div className="nd-note">A folder on the machine where AgentBus runs. The conversation works on its own copy of it, so your folder is not changed until you apply a turn's changes.</div>
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
