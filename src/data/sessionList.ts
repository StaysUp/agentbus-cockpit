// Ordering the session list against the stream, by the API's cursor
// (CLIENT_API.md: a cursor is the pair store and seq). A list's rows are
// computed from stored events up to its seq S; a streamed event with seq <= S
// is already counted in it.
import { CockpitEvent, SessionList, SessionSummary } from '../types';
import { addCost } from './turns';

// One streamed model.responded, kept until a list at or past its seq arrives.
export interface StreamedCost {
  id: string;
  session: string;
  seq: number;
  usd?: number;
  complete: boolean;
}

export interface ListCursor {
  store?: string;
  seq?: number;
}

// Whether a list should replace the shown one. A list from a source with no
// cursor always does. A list from another store never does by this path: the
// stream hands over a new snapshot when the store changes. An older list (lower
// seq) is ignored.
export function isNewerList(current: ListCursor | null, incoming: ListCursor): boolean {
  if (!current || current.seq === undefined || incoming.seq === undefined) return true;
  if (current.store !== incoming.store) return false;
  return incoming.seq >= current.seq;
}

// Whether a streamed event is already counted in the list at `cursor`.
export function countedIn(cursor: ListCursor | null, event: CockpitEvent): boolean {
  return cursor?.seq !== undefined && typeof event.seq === 'number' && event.seq <= cursor.seq;
}

export function streamedCost(event: CockpitEvent): StreamedCost | null {
  if (event.kind !== 'model.responded' || typeof event.seq !== 'number') return null;
  return {
    id: event.id,
    session: event.session,
    seq: event.seq,
    usd: typeof event.cost_usd === 'number' ? event.cost_usd : undefined,
    complete: typeof event.cost_usd === 'number' && event.cost_complete === true,
  };
}

// The list's rows with every streamed call after its seq added, and the calls
// still to keep (those the list does not yet count).
export function applyList(
  list: SessionList,
  buffer: StreamedCost[]
): { sessions: SessionSummary[]; buffer: StreamedCost[] } {
  const keep = list.seq === undefined ? [] : buffer.filter((c) => c.seq > list.seq!);
  const sessions = list.sessions.map((s) =>
    keep.reduce((row, c) => (c.session === row.id ? addCost(row, c.usd, c.complete) : row), s)
  );
  return { sessions, buffer: keep };
}
