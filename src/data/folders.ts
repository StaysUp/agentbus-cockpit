import { createContext, useContext } from 'react';

// The last few folders a session was started in, kept in localStorage so they
// survive the tab: one list per machine (its id, a runner's connector), and
// one for a service that names no machine. Folders only: never a token or
// anything else. Recents are history, not settings.

const KEY = 'agentbus.folders';
const KEEP = 10;

const keyOf = (machine?: string) => (machine ? `${KEY}.${machine}` : KEY);

export function recentFolders(machine?: string): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(keyOf(machine)) ?? '[]');
    return Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string').slice(0, KEEP) : [];
  } catch {
    return [];
  }
}

export function rememberFolder(folder: string, machine?: string): void {
  try {
    const list = [folder, ...recentFolders(machine).filter((f) => f !== folder)].slice(0, KEEP);
    localStorage.setItem(keyOf(machine), JSON.stringify(list));
  } catch {
    // Storage blocked: the field just starts empty next time.
  }
}

// Whether the last new session ran in a sandbox, remembered per viewer so the
// dialog offers the same choice next time. A copy behind a wall (true, the
// default) or the folder as it is (false). Stored as '1' or '0'; anything else,
// or storage blocked, reads as a sandbox.
const SANDBOX_KEY = 'agentbus.sandbox';

export function lastSandbox(): boolean {
  try {
    return localStorage.getItem(SANDBOX_KEY) !== '0';
  } catch {
    return true;
  }
}

export function rememberSandbox(sandbox: boolean): void {
  try {
    localStorage.setItem(SANDBOX_KEY, sandbox ? '1' : '0');
  } catch {
    // Storage blocked: a sandbox is offered next time.
  }
}

// The machine a session was last started on, so the dialog offers it first.
const MACHINE_KEY = 'agentbus.machine';

export function lastMachine(): string | undefined {
  try {
    return localStorage.getItem(MACHINE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberMachine(machine: string): void {
  try {
    localStorage.setItem(MACHINE_KEY, machine);
  } catch {
    // Storage blocked: the first online machine is offered next time.
  }
}

// A folder a runner reported, from GET /api/v0/folders. The path stays on the
// machine that owns it: name is its last part only.
export interface FolderInfo {
  ref: string;
  name: string;
  machine?: string;
  runner?: string;
}

// The folder to show for a turn or session: the folder's name when the API
// lists its reference, else the path the turn named. A turn on a runner
// built from a snapshot names its copy's path there, not the person's folder.
export function folderLabel(folder: string | undefined, ref: string | undefined, folders: FolderInfo[]): string | undefined {
  if (ref) {
    const f = folders.find((x) => x.ref === ref);
    if (f?.name) return f.name;
  }
  return folder || undefined;
}

// The folders the service lists, for every screen that shows a folder. Empty
// when the source lists none.
export const FoldersContext = createContext<FolderInfo[]>([]);

export function useFolders(): FolderInfo[] {
  return useContext(FoldersContext);
}

// A session's folder reference: its row's, else its latest turn's.
export function sessionFolderRef(s: { folder_ref?: string; turnsList?: { folderRef?: string }[] }): string | undefined {
  if (s.folder_ref) return s.folder_ref;
  const turns = s.turnsList ?? [];
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].folderRef) return turns[i].folderRef;
  return undefined;
}

// How many recent folders the New session dialog offers.
export const RECENT_KEEP = 10;

// The folders sessions were started in, newest first, once each, at most
// RECENT_KEEP: read from the record (GET /api/v0/sessions carries each
// session's folder and workspace), so every browser shows the same list.
//
// machineOf gives a session's machine from its workspace (GET
// /api/v0/workspaces): a workspace with no machine is on the service's own
// machine. With machine given, only that machine's folders; a session whose
// machine is not known is left out. clean makes two spellings of one path one.
export function recentFromSessions(
  sessions: { folder?: string; workspace?: string; started: string }[],
  clean: (p: string) => string,
  machine?: string,
  machineOf?: (workspace: string) => string | undefined
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const newest = [...sessions].sort((a, b) => b.started.localeCompare(a.started));
  for (const s of newest) {
    if (!s.folder) continue;
    if (machine !== undefined && (!s.workspace || machineOf?.(s.workspace) !== machine)) continue;
    const c = clean(s.folder);
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(s.folder);
    if (out.length === RECENT_KEEP) break;
  }
  return out;
}

// Each path's short label: its last part, or as many of its last parts as it
// takes to tell it from the others in the list.
export function shortPaths(paths: string[]): Map<string, string> {
  const parts = paths.map((p) => p.replace(/\/+$/, '').split('/').filter(Boolean));
  const depth = parts.map(() => 1);
  for (let round = 0; round < 64; round++) {
    const label = (i: number) => parts[i].slice(-depth[i]).join('/');
    let changed = false;
    for (let i = 0; i < parts.length; i++) {
      const same = parts.map((_, j) => j).filter((j) => j !== i && label(j) === label(i));
      if (same.length === 0) continue;
      for (const j of [i, ...same]) if (depth[j] < parts[j].length) {
        depth[j]++;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Every part needed: the path as it is.
  return new Map(paths.map((p, i) => [p, depth[i] < parts[i].length ? parts[i].slice(-depth[i]).join('/') : p]));
}
