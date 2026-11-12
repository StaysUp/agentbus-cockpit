import React, { act, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { CockpitEvent, DataSource, EventSelection, SessionDetail } from '../types';

let n = 0;
// A minimal event. Time advances one second per call so durations are stable.
export function ev(fields: Partial<CockpitEvent> & { kind: string }): CockpitEvent {
  n++;
  return {
    id: `e-${String(n).padStart(4, '0')}`,
    time: new Date(Date.UTC(2026, 10, 5, 9, 0, n)).toISOString(),
    session: 's1',
    ...fields,
  } as CockpitEvent;
}

export function jsonl(events: CockpitEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Rendered {
  container: HTMLElement;
  root: Root;
  unmount: () => void;
}

// Every root rendered and not yet unmounted, for unmountAll.
const mounted = new Set<Root>();

// unmountAll unmounts every root still mounted, so a page's window
// listeners and leave guard end with its test.
export function unmountAll(): void {
  for (const r of mounted) act(() => r.unmount());
  mounted.clear();
}

export async function render(node: React.ReactNode): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.add(root);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    root,
    unmount: () => {
      mounted.delete(root);
      act(() => root.unmount());
      container.remove();
    },
  };
}

export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

// Let pending promises and effects settle.
export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

// The parent's side of a RightPanel selection, as App keeps it: every select
// is a new action.
export function useSelection(id: string | null): [EventSelection | null, (id: string | null) => void] {
  const [sel, setSel] = useState<EventSelection | null>(id === null ? null : { id, nonce: 1 });
  return [sel, (next) => setSel((s) => ({ id: next, nonce: (s?.nonce ?? 0) + 1 }))];
}

// A session as the app shows it once every turn is opened: its row, and its
// turns each with its events. Reads only through the DataSource calls.
export async function openSession(src: DataSource, id: string): Promise<SessionDetail | null> {
  const row = (await src.getSessions()).find((s) => s.id === id);
  if (!row) return null;
  const { turns } = await src.getTurns(id);
  const turnsList = await Promise.all(
    turns.map(async (t) => ({ ...t, detail: (await src.getTurn(id, t.id)) ?? undefined }))
  );
  return { ...row, turnsList };
}

// A source that answers from a recorded file and streams: push() adds an
// event to the file, so the turn list and the turn events read after it
// include it, as the service's would, then streams it.
export function liveReplay(base: CockpitEvent[], extra: Partial<DataSource> = {}) {
  let events = [...base];
  let replay = new ReplayDataSource(jsonl(events));
  let onEvent: ((e: CockpitEvent) => void) | null = null;
  let unsubscribed = 0;
  const source: DataSource = {
    getAgents: () => replay.getAgents(),
    getSessions: (a) => replay.getSessions(a),
    getTurns: (id) => replay.getTurns(id),
    getTurn: (s, t) => replay.getTurn(s, t),
    subscribe: (cb, onSnapshot) => {
      onEvent = cb;
      replay.getSessions().then((list) => onSnapshot?.(list));
      return () => {
        unsubscribed++;
      };
    },
    ...extra,
  };
  const push = (e: CockpitEvent) => {
    events = [...events, e];
    replay = new ReplayDataSource(jsonl(events));
    onEvent?.(e);
  };
  return { source, push, unsubscribed: () => unsubscribed, replay: () => replay };
}

// The chat shows prompts and replies only; a call is reached through the
// panel. This clicks turn `turn` (which opens the panel there), its Model
// calls tab, the row of call `call` (unless it is open already) and "Open call".
export async function openCall(container: HTMLElement, turn = 0, call = 0): Promise<void> {
  await click(container.querySelectorAll('#convo .tb')[turn]);
  await flush();
  const tab = Array.from(container.querySelectorAll('#d-tabs .tab')).find((t) => t.textContent!.startsWith('Model calls'));
  await click(tab);
  const row = container.querySelectorAll('#d-body tr.ev')[call];
  if (!row) throw new Error(`no call row ${call}`);
  if (!row.classList.contains('sel')) await click(row);
  await click(container.querySelector('#d-body .open-call'));
}

// The line under the turn strip that says how the turn continued, or null.
export function continuedLine(container: HTMLElement): string | null {
  return container.querySelector('#d-head .turn-cont')?.textContent ?? null;
}

// The id of the session the conversation column shows.
export function shownSession(container: HTMLElement): string | undefined {
  return (container.querySelector('#convo') as HTMLElement | null)?.dataset.session;
}

// Whether the right panel is open. It starts closed; a turn or a call opens it.
export function panelOpen(container: HTMLElement): boolean {
  const slot = container.querySelector('.panel-slot') as HTMLElement | null;
  return !!slot && !slot.hidden;
}

// The id of a row in the Sessions column.
export function rowSession(row: Element): string | undefined {
  return (row as HTMLElement).dataset.session;
}

// The cockpit's own Select (components/Controls.tsx): its trigger is a
// button named like the field, its menu is drawn on document.body.
export function selectIn(scope: ParentNode, name: string): HTMLButtonElement | null {
  return scope.querySelector(`button[role="combobox"][name="${name}"]`);
}

// optionsOf opens the select and lists its options as [value, label, disabled], then closes it.
export async function optionsOf(scope: ParentNode, name: string): Promise<[string, string, boolean][]> {
  const sel = selectIn(scope, name)!;
  await click(sel);
  const list = Array.from(document.querySelectorAll('[role="listbox"] [role="option"]')).map(
    (o) => [o.getAttribute('data-value') ?? '', o.querySelector('.mi-l')?.textContent ?? '', (o as HTMLButtonElement).disabled] as [string, string, boolean]
  );
  await click(sel);
  return list;
}

// choose picks the option with value in the select named name.
export async function choose(scope: ParentNode, name: string, value: string): Promise<void> {
  const sel = selectIn(scope, name);
  if (!sel) throw new Error(`no select ${name}`);
  await click(sel);
  const opt = document.querySelector(`[role="listbox"] [role="option"][data-value="${value}"]`);
  if (!opt) throw new Error(`no option ${value} in ${name}`);
  await click(opt);
}
