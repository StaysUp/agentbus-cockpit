// The settings routes (/api/v0/settings), as the Settings page reads them:
// the settings' state, the policy, and the instructions. Every write sends back the ETag its read got, so a change
// made elsewhere in between is refused (412) rather than undone.

// A value and the ETag it was read with.
export interface Versioned<T> {
  value: T;
  etag: string;
}

// GET /api/v0/settings.
export interface SettingsInfo {
  version: number; // the save counter, sent as the ETag; not shown
  created?: string;
  changed?: string; // the last change; absent when none
  imported?: string;
  imported_files?: string[];
}

// The policy as GET /api/v0/settings/permissions sends it, every value
// filled. A nested key is a table, such as limits.max_depth.
export interface Policy {
  agent_api?: { apply?: boolean; [k: string]: unknown };
  home_files?: string[];
  [k: string]: unknown;
}

const isTable = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// flatPolicy is p by dotted key (limits.max_depth), each value as it is.
export function flatPolicy(p: Policy): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (isTable(v)) for (const [sk, sv] of Object.entries(v)) out[`${k}.${sk}`] = sv;
    else out[k] = v;
  }
  return out;
}

// nestPolicy is the dotted keys of flat as a policy: limits.max_depth goes
// under limits.
export function nestPolicy(flat: Record<string, unknown>): Policy {
  const out: Policy = {};
  for (const [k, v] of Object.entries(flat)) {
    const dot = k.indexOf('.');
    if (dot < 0) {
      out[k] = v;
      continue;
    }
    const t = k.slice(0, dot);
    const table = (isTable(out[t]) ? out[t] : {}) as Record<string, unknown>;
    table[k.slice(dot + 1)] = v;
    out[t] = table;
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// changeOf is what draft changes from read: only the keys whose value
// differs, nested as a policy. This is what a save sends (PATCH), never a
// full copy with the defaults filled in, which would keep every default at
// today's value after a later build changes it.
export function changeOf(read: Policy, draft: Policy): Policy {
  const r = flatPolicy(read);
  const changed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flatPolicy(draft))) {
    if (!(k in r) || !same(r[k], v)) changed[k] = v;
  }
  return nestPolicy(changed);
}

// isEmpty says a change holds no key.
export const isEmpty = (p: Policy) => Object.keys(p).length === 0;

// homeFilesOf is the files from the person's home copied into each
// conversation's own home (home_files).
export function homeFilesOf(p: Policy): string[] {
  return [...(p.home_files ?? [])];
}

// lines is text as a list: one entry per line, blank lines left out.
export function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

// One usual config path in the home of a folder's machine, as
// GET /api/v0/folders/{ref}/home-files lists it: its name, file or folder,
// and size. Never its contents.
export interface FoundPath {
  path: string; // as home_files takes it; a folder's ends in /
  kind: string; // "file" or "folder"
  size?: number;
  files?: number; // a folder's files, at any depth
  part?: string; // only this part is copied, such as mcpServers
  over?: boolean; // a folder too big for home_files: never added
}

// What Use my config found: the paths, and the machine they came from when
// the folders are on more than one, so the page can say which.
export interface ConfigFound {
  paths: FoundPath[];
  from?: string;
}

// addFound is the home files list text with each found path it does not
// hold yet added at its end, except a folder too big to copy. Every entry already there stays, in its order.
export function addFound(text: string, found: FoundPath[]): { text: string; added: string[] } {
  const have = lines(text);
  const seen = new Set(have);
  const added: string[] = [];
  for (const f of found) {
    if (f?.over) continue; // too big: home_files would refuse each turn
    const p = typeof f?.path === 'string' ? f.path.trim() : '';
    if (p === '' || seen.has(p)) continue;
    seen.add(p);
    added.push(p);
  }
  return { text: [...have, ...added].join('\n'), added };
}

// What the Settings page needs from a data source.
export interface SettingsApi {
  getSettings(): Promise<Versioned<SettingsInfo>>;
  getPolicy(): Promise<Versioned<Policy>>;
  // patchPolicy changes only the keys change holds; every other key keeps
  // what it holds (PATCH /api/v0/settings/permissions).
  patchPolicy(change: Policy, etag: string): Promise<Versioned<Policy>>;
  getInstructions(): Promise<Versioned<string>>;
  putInstructions(text: string, etag: string): Promise<Versioned<string>>;
  // findConfig lists the usual config paths in the home of a folder's
  // machine (GET /api/v0/folders/{ref}/home-files). Absent: a source
  // without the route.
  findConfig?(): Promise<ConfigFound>;
}
