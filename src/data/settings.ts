import type { RunnerInfo } from '../types';

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
  agent_api?: { apply?: boolean; tools?: boolean; [k: string]: unknown };
  network?: { contain?: string; allow?: string[] };
  sandbox?: { mode?: string; [k: string]: unknown };
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
// conversation's own home (home_files), sandbox on or off.
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

// What the Settings page needs from a data source.
export interface SettingsApi {
  getSettings(): Promise<Versioned<SettingsInfo>>;
  getPolicy(): Promise<Versioned<Policy>>;
  // patchPolicy changes only the keys change holds; every other key keeps
  // what it holds (PATCH /api/v0/settings/permissions).
  patchPolicy(change: Policy, etag: string): Promise<Versioned<Policy>>;
  getInstructions(): Promise<Versioned<string>>;
  putInstructions(text: string, etag: string): Promise<Versioned<string>>;
}

// Whether this setup can honour the sandbox setting, from the one source
// that knows: each machine's own report in GET /api/v0/runners
// (sandbox.can, and sandbox.why when it cannot). It can when at least one
// online machine that runs sessions reports it can; why says why not, in a
// plain sentence. runners is undefined before the first read and null when
// the source lists no machines.
export interface SandboxOffer {
  can: boolean;
  why?: string;
  // The online machines that can, by name.
  machines?: string[];
}

export function sandboxOffer(runners: RunnerInfo[] | null | undefined, error?: string | null): SandboxOffer {
  if (runners === undefined) {
    return { can: false, why: error ? `The machines could not be read: ${error}` : 'Reading which machines can build it…' };
  }
  if (runners === null) return { can: false, why: 'This control does not list its machines, so none reports it can.' };
  // A connector from before 0.5 takes no work, so it runs no session.
  const online = runners.filter((r) => r.online && r.role !== 'connector');
  const can = online.filter((r) => r.sandbox?.can);
  if (can.length > 0) return { can: true, machines: can.map((r) => r.name) };
  if (online.length === 0) return { can: false, why: 'No machine is online to build it.' };
  const each = online.map((r) => `${r.name}: ${r.sandbox ? (r.sandbox.why ?? 'it cannot') : 'it has not reported whether it can'}`);
  return { can: false, why: `No online machine can build it. ${each.join('; ')}.` };
}
