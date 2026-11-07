import React, { useEffect, useState } from 'react';
import { recentFolders } from '../data/folders';
import { InstalledAgent, RunRequest } from '../types';

interface NewSessionDialogProps {
  loadAgents: () => Promise<InstalledAgent[]>;
  // Rejects with the API's message when the run is refused.
  onStart: (req: RunRequest) => Promise<void>;
  onClose: () => void;
  initialAgent?: string;
}

// Start an agent in a folder with a first message (POST /api/v0/turns).
export const NewSessionDialog: React.FC<NewSessionDialogProps> = ({ loadAgents, onStart, onClose, initialAgent }) => {
  const [agents, setAgents] = useState<InstalledAgent[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agent, setAgent] = useState(initialAgent ?? '');
  const [recent] = useState(() => recentFolders());
  const [folder, setFolder] = useState(() => recent[0] ?? '');
  const [prompt, setPrompt] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadAgents().then(
      (list) => {
        if (!active) return;
        setAgents(list);
        setAgent((cur) => (list.some((a) => a.found && a.name === cur) ? cur : (list.find((a) => a.found)?.name ?? '')));
      },
      (err: Error) => active && setAgentsError(err.message)
    );
    return () => {
      active = false;
    };
  }, [loadAgents]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ready = agent !== '' && folder.trim() !== '' && prompt.trim() !== '' && !starting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setStarting(true);
    setError(null);
    try {
      await onStart({ agent, folder: folder.trim(), prompt, read_only: readOnly });
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
              <option key={a.name} value={a.name} disabled={!a.found}>
                {a.found ? `${a.name}${a.version ? ` ${a.version}` : ''}` : `${a.name} (not installed)`}
              </option>
            ))}
          </select>
        </label>
        {agentsError && <div className="form-error">{agentsError}</div>}
        {agents && agents.length === 0 && <div className="nd-note">The service found no agents.</div>}
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
        <label>
          <span>First message</span>
          <textarea name="prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <label className="nd-check">
          <input name="read_only" type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
          <span>Read only</span>
        </label>
        <div className="nd-note">
          {readOnly
            ? 'The agent can read files but not change them.'
            : 'The agent follows its own permission settings.'}
        </div>
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
