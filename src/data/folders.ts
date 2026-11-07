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
