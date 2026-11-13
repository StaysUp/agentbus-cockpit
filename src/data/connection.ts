// Where the cockpit connects, kept for this tab only. The token goes in
// sessionStorage (cleared when the tab closes), never localStorage, never a URL.

export const DEFAULT_ADDRESS = 'http://127.0.0.1:8787';

const ADDRESS_KEY = 'agentbus.address';
const TOKEN_KEY = 'agentbus.token';
const MODE_KEY = 'agentbus.mode';
// A separate control plane's address and token, from before there was one
// API. Never read; removed wherever the connection is saved or cleared.
const OLD_KEYS = ['agentbus.jobs.address', 'agentbus.jobs.token'];

function dropOld(): void {
  for (const k of OLD_KEYS) sessionStorage.removeItem(k);
}

// One address and one token: sessions, turns, model calls and reviews all
// come from the one agentbus API.
export interface Connection {
  address: string;
  token: string;
}

export type Saved = { mode: 'live'; connection: Connection } | { mode: 'replay' } | null;

// Storage can throw (private windows, blocked site data); then nothing is kept.
function get(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function loadSaved(): Saved {
  if (get(MODE_KEY) === 'replay') return { mode: 'replay' };
  const address = get(ADDRESS_KEY);
  const token = get(TOKEN_KEY);
  if (!address || !token) return null;
  return { mode: 'live', connection: { address, token } };
}

export function saveConnection(c: Connection): void {
  try {
    sessionStorage.removeItem(MODE_KEY);
    dropOld();
    sessionStorage.setItem(ADDRESS_KEY, c.address);
    sessionStorage.setItem(TOKEN_KEY, c.token);
  } catch {
    // Not kept: the next reload asks again.
  }
}

export function saveReplay(): void {
  try {
    sessionStorage.removeItem(ADDRESS_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    dropOld();
    sessionStorage.setItem(MODE_KEY, 'replay');
  } catch {
    // Not kept.
  }
}

export function clearSaved(): void {
  try {
    sessionStorage.removeItem(ADDRESS_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(MODE_KEY);
    dropOld();
  } catch {
    // Nothing to clear.
  }
}

export function normalizeAddress(address: string): string {
  return address.trim().replace(/\/+$/, '');
}

export const CHECK_TIMEOUT_MS = 10_000;

// Checks the address and token with GET /api/v0/sessions. Returns null when
// they work, or a plain sentence saying what went wrong. The fetch and the
// body read share one 10-second limit: a service that answers and then keeps
// the body open fails the same way as one that never answers.
export async function checkConnection(c: Connection, pageOrigin: string): Promise<string | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(`agentbus at ${c.address} did not answer within ${CHECK_TIMEOUT_MS / 1000} seconds`);
    }, CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([check(c, pageOrigin, controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function check(c: Connection, pageOrigin: string, signal: AbortSignal): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${c.address}/api/v0/sessions`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${c.token}` },
      signal,
    });
  } catch {
    // A refused connection and a missing CORS header look the same from here.
    // Plain `agentbus up` allows every origin; -origin locks it to one.
    return `cannot reach agentbus at ${c.address}; start it with \`agentbus up\` (if it runs with -origin, that must be ${pageOrigin})`;
  }
  if (res.status === 401) return 'the token was refused';
  if (!res.ok) return `agentbus at ${c.address} answered ${res.status}`;
  // A 200 from something else (a web page on that port) is not agentbus.
  const body: unknown = await res.json().catch(() => null);
  if (!isSnapshot(body)) return `agentbus at ${c.address} did not answer like agentbus`;
  return null;
}

// The shape of GET /api/v0/sessions: a string store, a number seq, an array of sessions.
function isSnapshot(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return typeof b.store === 'string' && typeof b.seq === 'number' && Array.isArray(b.sessions);
}

// Served by agentbus itself (agentbus up packs the cockpit): index.html then
// carries <meta name="agentbus" content="served">, and the API is this page's
// own origin. From the dev server there is no such tag.
export function servedByAgentbus(doc: Document = document): boolean {
  return doc.querySelector('meta[name="agentbus"][content="served"]') !== null;
}

// The one-time code of agentbus up's sign-in link, /?t=<code>. Read once and
// removed from the address bar at once, so it is not kept in history or
// bookmarks. Null when there is none.
export function takeSignInCode(loc: Location = window.location, hist: History = window.history): string | null {
  const url = new URL(loc.href);
  const code = url.searchParams.get('t');
  if (code === null) return null;
  url.searchParams.delete('t');
  try {
    hist.replaceState(hist.state, '', url.pathname + url.search + url.hash);
  } catch {
    // The code is used up below either way.
  }
  return code || null;
}

export const SIGN_IN_EXPIRED =
  'the sign-in link was already used or has expired; start `agentbus up` again for a new one';

// Trades the code for the token, once (POST /api/v0/signin). Returns the
// token, or a plain sentence saying what went wrong.
export async function exchangeSignInCode(
  address: string,
  code: string
): Promise<{ token: string } | { error: string }> {
  let res: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    res = await fetch(`${address}/api/v0/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code }),
      signal: controller.signal,
    });
  } catch {
    return { error: `cannot reach agentbus at ${address}; is \`agentbus up\` still running?` };
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) return { error: SIGN_IN_EXPIRED };
  if (!res.ok) return { error: `agentbus at ${address} answered ${res.status} to the sign-in link` };
  const body: unknown = await res.json().catch(() => null);
  const token = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).token : undefined;
  if (typeof token !== 'string' || token === '') return { error: `agentbus at ${address} did not answer like agentbus` };
  return { token };
}
