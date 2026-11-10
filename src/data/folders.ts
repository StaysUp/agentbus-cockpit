import { createContext, useContext } from 'react';

// The last few folders a session was started in, kept in localStorage so they
// survive the tab. Folders only: never a token or anything else.

const KEY = 'agentbus.folders';
const KEEP = 5;

export function recentFolders(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string').slice(0, KEEP) : [];
  } catch {
    return [];
  }
}

export function rememberFolder(folder: string): void {
  try {
    const list = [folder, ...recentFolders().filter((f) => f !== folder)].slice(0, KEEP);
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage blocked: the field just starts empty next time.
  }
}

// A folder a runner reported, from GET /api/v0/folders. The path stays on the
// machine that owns it: name is its last part only.
export interface FolderInfo {
  ref: string;
  name: string;
  connector?: string;
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
