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
// filled. Only the keys the page shows as grants are named; the rest pass
// through untouched.
export interface Policy {
  agent_api?: { apply?: boolean; [k: string]: unknown };
  network?: { contain?: string; allow?: string[] };
  sandbox?: { mode?: string; read?: string[] };
  [k: string]: unknown;
}

// What the network grant is, in three words. off: an agent reaches only its
// runner's gateway and the server ([network] contain on, allow empty). list:
// those and the hosts in allow. on: any host (contain off).
export type NetworkGrant = 'off' | 'list' | 'on';

// The grants: one global set, the same for every machine.
export interface Grants {
  read: string[];
  sandbox: 'off' | 'on';
  network: NetworkGrant;
  hosts: string[];
  agentsApply: boolean;
}

export function networkOf(p: Policy): NetworkGrant {
  if (p.network?.contain !== 'on') return 'on';
  return (p.network.allow ?? []).length > 0 ? 'list' : 'off';
}

export function grantsOf(p: Policy): Grants {
  return {
    read: [...(p.sandbox?.read ?? [])],
    sandbox: p.sandbox?.mode === 'on' ? 'on' : 'off',
    network: networkOf(p),
    hosts: [...(p.network?.allow ?? [])],
    agentsApply: p.agent_api?.apply !== false,
  };
}

// withGrants is p with g written into its keys. Network off empties allow;
// on keeps allow as it is (with the sandbox on, it still names the hosts of
// this machine's own networks an agent may reach).
export function withGrants(p: Policy, g: Grants): Policy {
  const allow = g.network === 'off' ? [] : g.network === 'list' ? g.hosts : (p.network?.allow ?? []);
  return {
    ...p,
    agent_api: { ...(p.agent_api ?? {}), apply: g.agentsApply },
    network: { ...(p.network ?? {}), contain: g.network === 'on' ? 'off' : 'on', allow },
    sandbox: { ...(p.sandbox ?? {}), mode: g.sandbox, read: g.read },
  };
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
  putPolicy(p: Policy, etag: string): Promise<Versioned<Policy>>;
  getInstructions(): Promise<Versioned<string>>;
  putInstructions(text: string, etag: string): Promise<Versioned<string>>;
}
