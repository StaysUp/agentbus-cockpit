import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FolderInfo, lastMachine, lastSandbox, recentFolders, rememberSandbox } from '../data/folders';
import { Harness, RunRequest, RunnerInfo, SavedAgent } from '../types';
import { agentLine } from './AgentsDialog';
import { Button, Seg, Select } from './Controls';
import { Dialog, DialogActions } from './Dialog';
import { CloseIcon, PlusIcon } from './Icons';
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

// cleanPath is a typed path as the service cleans it: no repeated, trailing or
// "." parts, and ".." taken back. Two paths that clean the same are one folder.
export function cleanPath(p: string): string {
  const t = p.trim();
  const abs = t.startsWith('/');
  const out: string[] = [];
  for (const part of t.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else if (part !== '..' || !abs) out.push(part);
  }
  return (abs ? '/' : '') + out.join('/');
}

// A session works in at most this many folders (the service's limit).
const MAX_FOLDERS = 8;

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
  // The listed folders and the recent paths of the machine picked; all of
  // them on a service that names no machine. At most five recent paths,
  // newest first (recentFolders keeps no more).
  const folders = byMachine ? allFolders.filter((f) => f.machine === machine) : allFolders;
  const recent = useMemo(() => recentFolders(byMachine ? machine : undefined), [byMachine, machine]);
  // No folder is picked for the person: the session runs where they say,
  // so Start waits for a listed folder, a recent one or a typed path. A
  // listed folder that leaves the list is dropped.
  // A session at Copy may work in several folders on one machine, side by
  // side in one copy: one row each, + Add folder for the next. The picks sit
  // under the row last focused (the active row) and fill that row. Tab goes
  // from a row's field to its picks, then on to the next row, which takes
  // the picks with it.
  const [wheres, setWheres] = useState<(Where | null)[]>([null]);
  const [active, setActive] = useState(0);
  const folderKey = folders.map((f) => f.ref).join(',');
  useEffect(() => {
    setWheres((ws) => ws.map((cur) => (cur && 'ref' in cur && !folders.some((f) => f.ref === cur.ref) ? null : cur)));
    // folders is derived from allFolders and machine each render.
  }, [folderKey]);
  const setRow = (i: number, w: Where | null) => setWheres((ws) => ws.map((x, j) => (j === i ? w : x)));
  const pick = (w: Where) => setRow(Math.min(active, wheres.length - 1), w);
  // Adding or removing a row takes the button that did it away (remove goes
  // with its row; + Add folder at the last row), so focus moves to a row's
  // field, never to the page behind the dialog.
  const rowRefs = useRef<(HTMLInputElement | null)[]>([]);
  const focusRow = useRef<number | null>(null);
  useEffect(() => {
    if (focusRow.current !== null) {
      rowRefs.current[focusRow.current]?.focus();
      focusRow.current = null;
    }
  }, [wheres.length]);
  const addFolder = () => {
    focusRow.current = wheres.length;
    setActive(wheres.length);
    setWheres((ws) => [...ws, null]);
  };
  const removeFolder = (i: number) => {
    const next = Math.max(0, i - 1);
    focusRow.current = next;
    setActive(next);
    setWheres((ws) => ws.filter((_, j) => j !== i));
  };
  // Another machine holds other folders: the folders are picked again.
  const pickMachine = (m: string) => {
    setMachineTouched(true);
    if (m !== machine) {
      setWheres([null]);
      setActive(0);
    }
    setMachine(m);
  };
  const several = wheres.length > 1;
  // A row shows its folder as the picks show it: a listed folder by its name,
  // a path as typed. One row or several, the same way.
  const rowText = (w: Where | null) => (!w ? '' : 'path' in w ? w.path : (folders.find((f) => f.ref === w.ref)?.name ?? w.ref));
  // The picks show each folder once: a recent path twice in two spellings is
  // one, and a recent path whose last part names a listed folder is that
  // folder, shown by its name. The path stays on its machine, so the name is
  // all the list has to match on.
  const listedNames = new Set(folders.map((f) => f.name));
  const recentPicks = recent.filter((f, i) => {
    const c = cleanPath(f);
    if (listedNames.has(c.split('/').pop() ?? '')) return false;
    return recent.findIndex((g) => cleanPath(g) === c) === i;
  });
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  // The session's mode, remembered per viewer. On (the default): a sandbox,
  // run in a copy of the folder whose changes you apply. Off: the agent works
  // in the folder as it is.
  const [sandbox, setSandbox] = useState(lastSandbox);
  // Where a Copy session starts: the folder as it is (the default), or a git
  // base of the folder's repo -- a local branch, tag or commit, or a branch
  // fetched from a remote first. The service resolves it when the workspace
  // is made, so a name it cannot find is refused here, on the form.
  const [start, setStart] = useState<'folder' | 'local' | 'remote'>('folder');
  const [base, setBase] = useState('');
  const [remote, setRemote] = useState('origin');
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
  const filled = (w: Where | null) => !!w && ('ref' in w || w.path.trim() !== '');
  const hasWhere = wheres.every(filled);
  // Several folders are one per row, on one machine: the service refuses the
  // same folder twice, and folders of two machines.
  const keyOf = (w: Where | null) => (!w ? '' : 'ref' in w ? `ref:${w.ref}` : `path:${cleanPath(w.path)}`);
  // A row whose folder an earlier row already has is refused in place.
  const isDup = (i: number) => filled(wheres[i]) && wheres.slice(0, i).some((x) => keyOf(x) === keyOf(wheres[i]));
  const twice = several && wheres.some((_, i) => isDup(i));
  const rowMachines = new Set(wheres.flatMap((w) => (w && 'ref' in w && w.machine ? [w.machine] : [])));
  const mixed = several && rowMachines.size > 1;
  const rowsOk = !twice && !mixed;
  const machineOk = !byMachine || (!!picked && picked.online);
  const fromBase = sandbox && !several && start !== 'folder';
  const baseOk = !fromBase || (base.trim() !== '' && (start !== 'remote' || remote.trim() !== ''));
  const ready = agent !== '' && hasWhere && rowsOk && machineOk && baseOk && !starting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) {
      setTried(true);
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const one = wheres[0]!;
      const at = several
        ? {
            folders: wheres.map((w) => ('ref' in w! ? { folder_ref: w.ref } : { folder: w!.path.trim() })),
            ...(byMachine ? { machine } : [...rowMachines].length > 0 ? { machine: [...rowMachines][0] } : {}),
          }
        : 'ref' in one
          ? { folder_ref: one.ref, machine: one.machine }
          : { folder: one.path.trim(), ...(byMachine ? { machine: machine } : {}) };
      const from = fromBase
        ? { base: base.trim(), ...(start === 'remote' ? { remote: remote.trim() } : {}) }
        : {};
      rememberSandbox(sandbox);
      await onStart({ agent, ...at, sandbox, ...from, prompt: prompt.trim() === '' ? '' : prompt }, name.trim() || undefined);
    } catch (err) {
      const msg = (err as Error).message;
      setError((wheres.some((w) => w && 'path' in w) && folderRefusal(msg)) || msg);
      setStarting(false);
    }
  };

  return (
    <Dialog title={`New ${SESSION}`} onClose={onClose} busy={starting} onSubmit={submit} className="session-dialog">
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
        <div className="nd-folders" role="group" aria-labelledby="nd-folders-label">
          <span id="nd-folders-label">{several ? 'Folders' : 'Folder'}</span>
          {wheres.map((w, i) => {
            const dup = isDup(i);
            const bad = dup || (tried && !filled(w));
            const atRow = i === Math.min(active, wheres.length - 1);
            return (
              <React.Fragment key={i}>
                <div className="nd-frow">
                  <input
                    name={i === 0 ? 'folder' : `folder-${i + 1}`}
                    ref={(el) => {
                      rowRefs.current[i] = el;
                    }}
                    type="text"
                    aria-label={several ? `Folder ${i + 1}` : 'Folder'}
                    aria-invalid={bad ? true : undefined}
                    className={bad ? 'invalid' : undefined}
                    value={rowText(w)}
                    onFocus={() => setActive(i)}
                    onChange={(e) => setRow(i, { path: e.target.value })}
                    placeholder={folders.length > 0 || recentPicks.length > 0 ? 'Pick one below, or type a path' : 'Path to a folder'}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  {several && (
                    <button
                      type="button"
                      className="icon-btn nd-remove"
                      aria-label={`Remove folder ${i + 1}`}
                      title="Remove folder"
                      onClick={() => removeFolder(i)}
                    >
                      <CloseIcon />
                    </button>
                  )}
                </div>
                {dup && (
                  <Notice kind="error" className="nd-dup">
                    This folder is already in the list.
                  </Notice>
                )}
                {atRow && (folders.length > 0 || recentPicks.length > 0) && (
                  <div className="nd-recent">
                    {folders.map((f) => (
                      <button
                        type="button"
                        key={f.ref}
                        className={`pick${w && 'ref' in w && w.ref === f.ref ? ' on' : ''}`}
                        title={f.ref}
                        onClick={() => pick({ ref: f.ref, machine: f.machine })}
                      >
                        <code>{f.name || f.ref}</code>
                      </button>
                    ))}
                    {recentPicks.map((f) => (
                      <button type="button" key={f} className={`pick${w && 'path' in w && w.path === f ? ' on' : ''}`} onClick={() => pick({ path: f })}>
                        <code>{f}</code>
                      </button>
                    ))}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
        {hasWhere && !twice && mixed && tried && (
          <Notice kind="error" className="nd-missing">
            All folders of a session are on one machine.
          </Notice>
        )}
        {!hasWhere && tried && (
          <Notice kind="error" className="nd-missing">
            {several ? 'Pick a folder for each row, or remove it.' : 'Pick a folder to start.'}
          </Notice>
        )}
        {sandbox && wheres.length < MAX_FOLDERS && (
          <div className="nd-add">
            <Button kind="quiet" small className="nd-add-folder" onClick={addFolder}>
              <PlusIcon />
              Add folder
            </Button>
            {!several && <span className="nd-note">Work in several folders in one copy.</span>}
          </div>
        )}
        <div className="nd-note">
          {byMachine ? `A folder on ${picked?.name ?? 'the machine picked'}.` : `A folder on the machine ${PRODUCT} runs on.`}
        </div>
        <label className="nd-sandbox">
          <span>Where it runs</span>
          <Seg
            label="Where the session runs"
            dataKey="mode"
            value={sandbox ? 'copy' : 'direct'}
            options={[
              {
                value: 'direct',
                label: 'Direct',
                disabled: several,
                title: several ? 'Direct works in one folder' : undefined,
              },
              { value: 'copy', label: 'Copy' },
              {
                value: 'locked',
                label: 'Locked',
                disabled: true,
                title: 'Coming later: also hides your secrets and holds anything going out',
              },
            ]}
            onChange={(v) => setSandbox(v === 'copy')}
          />
          <div className="nd-note">
            {sandbox
              ? 'Works in a copy. Your folder changes only when you apply.'
              : 'Works in your folder as it is — no copy to apply.'}
          </div>
        </label>
        {sandbox && (
          <label className="nd-start">
            <span>Start from</span>
            <Seg
              label="Where the session starts from"
              dataKey="start"
              value={start}
              options={[
                { value: 'folder', label: 'Folder as it is' },
                { value: 'local', label: 'Local branch' },
                { value: 'remote', label: 'Remote branch' },
              ]}
              onChange={(v) => setStart(v as 'folder' | 'local' | 'remote')}
            />
            {start === 'folder' && (
              <div className="nd-note">The copy has your folder exactly as it is, uncommitted edits included.</div>
            )}
          </label>
        )}
        {fromBase && (
          <div className="nd-base">
            {start === 'remote' && (
              <label>
                <span>Remote</span>
                <input
                  name="remote"
                  type="text"
                  value={remote}
                  onChange={(e) => setRemote(e.target.value)}
                  placeholder="origin"
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={tried && remote.trim() === '' ? true : undefined}
                />
              </label>
            )}
            <label>
              <span>{start === 'remote' ? 'Branch' : 'Branch, tag or commit'}</span>
              <input
                name="base"
                type="text"
                value={base}
                onChange={(e) => setBase(e.target.value)}
                placeholder={start === 'remote' ? 'feature/login' : 'main, feature/login, v1.2 or a commit id'}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={tried && base.trim() === '' ? true : undefined}
                className={tried && base.trim() === '' ? 'invalid' : undefined}
              />
            </label>
            {tried && !baseOk && (
              <Notice kind="error" className="nd-missing">
                {start === 'remote' ? 'Name the remote and the branch to start from.' : 'Name the branch, tag or commit to start from.'}
              </Notice>
            )}
            <div className="nd-note">
              {start === 'remote'
                ? 'Fetched from the remote first, so the session starts from what it has now. Your folder and its branch do not change.'
                : 'Starts from that commit as your repo has it. Your uncommitted edits are not in it, and your folder does not change.'}{' '}
              Files git ignores, such as .env, come along only when Settings, Config, Copied from your folder names them.
            </div>
          </div>
        )}
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
