import React, { useEffect, useState } from 'react';
import { recentFolders } from '../data/folders';
import { InstalledAgent, RunRequest } from '../types';

interface NewSessionDialogProps {
  loadAgents: () => Promise<InstalledAgent[]>;
  // Rejects with the API's message when the run is refused.
  onStart: (req: RunRequest) => Promise<void>;
  onClose: () => void;
  initialAgent?: string;
  // A control plane is connected: the turn runs as a job, and can run in a
  // new git worktree of the folder.
  jobs?: boolean;
}

// Start an agent in a folder with a first message (POST /api/v0/turns).
export const NewSessionDialog: React.FC<NewSessionDialogProps> = ({ loadAgents, onStart, onClose, initialAgent, jobs }) => {
  const [agents, setAgents] = useState<InstalledAgent[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agent, setAgent] = useState(initialAgent ?? '');
  const [recent] = useState(() => recentFolders());
  const [folder, setFolder] = useState(() => recent[0] ?? '');
  const [prompt, setPrompt] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [model, setModel] = useState('');
  // With a control plane: a new worktree at base (the default), or the folder as it is.
  const [worktree, setWorktree] = useState(true);
  const [base, setBase] = useState('HEAD');
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

  const useWorktree = !!jobs && worktree;
  const ready =
    agent !== '' && folder.trim() !== '' && prompt.trim() !== '' && (!useWorktree || base.trim() !== '') && !starting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setStarting(true);
    setError(null);
    try {
      const req: RunRequest = { agent, folder: folder.trim(), prompt, read_only: readOnly };
      if (model.trim()) req.model = model.trim();
      if (useWorktree) req.base = base.trim();
      await onStart(req);
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
        {jobs && (
          <>
            <div className="nd-seg" role="radiogroup" aria-label="Workspace">
              <button type="button" role="radio" aria-checked={worktree} className={worktree ? 'on' : ''} onClick={() => setWorktree(true)}>
                New worktree
              </button>
              <button type="button" role="radio" aria-checked={!worktree} className={!worktree ? 'on' : ''} onClick={() => setWorktree(false)}>
                This folder, as it is
              </button>
            </div>
            {worktree && (
              <label>
                <span>From</span>
                <input name="base" type="text" value={base} onChange={(e) => setBase(e.target.value)} spellCheck={false} autoComplete="off" />
              </label>
            )}
            <div className="nd-note">
              {worktree
                ? 'The folder must be a git repository. A runner makes a worktree of it at this branch, tag or commit, and the session runs there.'
                : 'A runner runs the session in this folder, with whatever is in it now.'}
            </div>
          </>
        )}
        <label>
          <span>Model</span>
          <input name="model" type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="the agent's default" spellCheck={false} autoComplete="off" />
        </label>
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
            {starting ? (jobs ? 'Waiting for a runner…' : 'Starting…') : 'Start'}
          </button>
          <button type="button" className="use-recorded" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
};
