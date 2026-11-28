import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CloseState, WorkspaceRow } from '../types';
import { FolderInfo, folderLabel } from '../data/folders';
import { formatAgo } from '../utils/format';
import { failedWords, followOutcome, WorkspaceOutcome } from '../data/outcome';
import { Button } from './Controls';
import { UnappliedIcon } from './Icons';
import { RUNNERS_POLL_MS } from './RunnersList';

// What the Runners page needs for its workspaces: the list, and Close.
export interface WorkspacesApi {
  list: () => Promise<WorkspaceRow[] | null>;
  close: (workspace: string) => Promise<CloseState>;
  // GET /api/v0/workspaces/{id}/outcome?event=: how the close whose 202 named
  // event stands. Absent on an older service: the list alone says it closed.
  outcome?: (workspace: string, event: string) => Promise<WorkspaceOutcome>;
}

export const UNAPPLIED = 'Changes not applied yet';
export const CLOSE_WAITING = 'The close waits behind a turn in this workspace. Click to ask again.';
// A close answers 202 at once and runs as a job; workspace.closed on the record
// says it ran. While one waits the list is read every CLOSE_POLL_MS, so the row
// goes soon after. One not closed CLOSE_STALL_MS after it was asked is shown as
// not closed, with Close to ask again, rather than Closing… for ever.
export const CLOSE_POLL_MS = 3000;
export const CLOSE_STALL_MS = 3 * 60_000;
export const closeStalled = (askedMs: number, now: number) => {
  const min = Math.max(1, Math.round((now - askedMs) / 60_000));
  return `Asked ${min} min ago and not closed yet. It may wait behind a running turn, or the runner may be away. Close asks again.`;
};

// The workspaces the page shows: sandbox ones whose copy is still there
// (Close is for a copy only), newest first. Undefined before the first read,
// null on a service without the route.
//
// closing holds the workspaces whose Close was asked here and that the service
// still lists open: the close waits behind a turn, or has not run yet. A
// workspace leaves it once a read lists it closed (its row goes) or not at all.
// stalled holds those of them asked more than CLOSE_STALL_MS ago, with when they
// were asked. The list is what the service says, so a workspace a later turn
// copies again shows again.
export function useWorkspaces(api?: WorkspacesApi): {
  rows: WorkspaceRow[] | null | undefined;
  error: string | null;
  closing: ReadonlySet<string>;
  stalled: ReadonlyMap<string, number>;
  // Marks a workspace as being closed and reads the list again.
  onClosing: (workspace: string) => void;
  // The close's outcome said it ran (workspace.closed) or failed: the row goes
  // at once, or comes back to Close.
  onClosed: (workspace: string, ok: boolean) => void;
} {
  const [rows, setRows] = useState<WorkspaceRow[] | null | undefined>(api ? undefined : null);
  const [error, setError] = useState<string | null>(null);
  // Each close asked here and not yet listed closed, with when it was asked.
  const [asked, setAsked] = useState<ReadonlyMap<string, number>>(() => new Map());
  // Closes the outcome route said ran, kept until a read lists them closed.
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const reread = useRef<() => void>(() => {});
  useEffect(() => {
    if (!api) return;
    let live = true;
    const read = () =>
      api.list().then(
        (got) => {
          if (!live) return;
          setRows(got);
          setError(null);
          setNow(Date.now());
          setAsked((m) => {
            if (m.size === 0) return m;
            const open = new Set((got ?? []).filter((w) => !w.closed).map((w) => w.workspace));
            const left = new Map([...m].filter(([id]) => open.has(id)));
            return left.size === m.size ? m : left;
          });
          setDone((d) => {
            if (d.size === 0) return d;
            const open = new Set((got ?? []).filter((w) => !w.closed).map((w) => w.workspace));
            const left = new Set([...d].filter((id) => open.has(id)));
            return left.size === d.size ? d : left;
          });
        },
        (e: unknown) => {
          if (live) setError(e instanceof Error ? e.message : String(e));
        }
      );
    reread.current = read;
    read();
    const timer = setInterval(read, RUNNERS_POLL_MS);
    return () => {
      live = false;
      reread.current = () => {};
      clearInterval(timer);
    };
  }, [api]);
  // While a close waits, read more often, so its row goes soon after it ran.
  const waiting = asked.size > 0;
  useEffect(() => {
    if (!api || !waiting) return;
    const timer = setInterval(() => reread.current(), CLOSE_POLL_MS);
    return () => clearInterval(timer);
  }, [api, waiting]);
  const open = rows
    ?.filter((w) => w.sandbox && !w.closed && !done.has(w.workspace))
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  const onClosing = useCallback((id: string) => {
    const at = Date.now();
    setNow(at);
    setAsked((m) => new Map(m).set(id, at));
    reread.current();
  }, []);
  const onClosed = useCallback((id: string, ok: boolean) => {
    setAsked((m) => {
      if (!m.has(id)) return m;
      const next = new Map(m);
      next.delete(id);
      return next;
    });
    if (ok) setDone((d) => new Set(d).add(id));
    reread.current();
  }, []);
  const closing = new Set<string>();
  const stalled = new Map<string, number>();
  for (const [id, at] of asked) {
    if (now - at > CLOSE_STALL_MS) stalled.set(id, at);
    else closing.add(id);
  }
  return { rows: rows === null ? null : open, error, closing, stalled, onClosing, onClosed };
}

// A workspace's state on the Runners page: open (its copy is there) or
// closing (a Close asked here has not run yet). A closed or put-away
// workspace has no copy left, so the page never lists it.
export type WorkspaceState = 'open' | 'closing';
const STATE_TIP: Record<WorkspaceState, string> = {
  open: 'Its copy is on the machine.',
  closing: CLOSE_WAITING,
};

// A workspace has changes not applied when its latest turn with changes is
// not the one its latest apply went up to.
export const hasUnapplied = (w: WorkspaceRow) => !!w.head_turn && w.head_turn !== w.applied_turn;

const lastPart = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

// The folder names of a workspace, as one line, and their full paths for the
// tooltip.
function folderNames(w: WorkspaceRow, known: FolderInfo[]): { names: string; paths: string } {
  const fs = w.folders?.length ? w.folders : [{ folder: w.folder, folder_ref: w.folder_ref }];
  const one = (f: { name?: string; folder?: string; folder_ref?: string }) => {
    const label = folderLabel(f.folder, f.folder_ref, known);
    return f.name || (label ? lastPart(label) : f.folder_ref || 'folder');
  };
  return {
    names: fs.map(one).join(', '),
    paths: fs.map((f) => f.folder || folderLabel(undefined, f.folder_ref, known) || f.folder_ref || '').filter(Boolean).join('\n'),
  };
}

// One machine's open workspaces, on its page below Harnesses, in the same
// table: the folder names in full (the paths on hover), when it was made, a
// mark for changes not applied, and Close. A row whose close the service has
// not finished reads Closing…, and goes once the service lists it closed. A
// refusal or a failed close shows under the row in the API's words.
export const WorkspacesTable: React.FC<{
  rows: WorkspaceRow[];
  // The title of the session (or sessions) whose turns run in a workspace.
  taskOf?: (workspace: string) => string | undefined;
  folders?: FolderInfo[];
  close?: (workspace: string) => Promise<CloseState>;
  closing?: ReadonlySet<string>;
  stalled?: ReadonlyMap<string, number>;
  onClosing: (workspace: string) => void;
  outcome?: (workspace: string, event: string) => Promise<WorkspaceOutcome>;
  onClosed?: (workspace: string, ok: boolean) => void;
}> = ({ rows, taskOf, folders = [], close, closing, stalled, onClosing, outcome, onClosed }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ id: string; text: string } | null>(null);
  if (rows.length === 0) return null;
  const doClose = (id: string) => {
    if (!close) return;
    setBusy(id);
    setErr(null);
    close(id).then(
      (st) => {
        setBusy(null);
        if (st.state === 'failed') {
          setErr({ id, text: failedWords('close', st) });
          return;
        }
        // The row stays, marked Closing…, while the close waits. Its outcome
        // (the event the 202 named) says when it ran or failed; without the
        // route, the list read alone says so.
        onClosing(id);
        if (!st.event || !outcome) return;
        followOutcome(st, (ev) => outcome(id, ev), { giveUpMs: CLOSE_STALL_MS }).then((o) => {
          if (o.state === 'closed') onClosed?.(id, true);
          else if (o.state === 'failed') {
            onClosed?.(id, false);
            setErr({ id, text: failedWords('close', o) });
          }
          // stalled: the row says so from the list's own clock.
        });
      },
      (e: unknown) => {
        setBusy(null);
        setErr({ id, text: e instanceof Error ? e.message : String(e) });
      }
    );
  };
  const cols = close ? 5 : 4;
  const row = (w: WorkspaceRow) => {
    const { names, paths } = folderNames(w, folders);
    const waiting = !!closing?.has(w.workspace) || busy === w.workspace;
    const stalledAt = stalled?.get(w.workspace);
    const state: WorkspaceState = waiting ? 'closing' : 'open';
    const task = taskOf?.(w.workspace);
    return (
      <React.Fragment key={w.workspace}>
        <tr data-workspace={w.workspace} data-state={state}>
          <td className="ws-n">
            <div className={`ws-task${task ? '' : ' dim'}`}>{task || 'No session yet'}</div>
            <div className="ws-sub dim" title={paths || undefined}>
              {names} · <code className="ws-id">{w.workspace}</code>
            </div>
          </td>
          <td className="t ws-age" title={new Date(w.created).toLocaleString()}>
            {formatAgo(w.created) || '—'}
          </td>
          <td className={`ws-state st-${state}`} title={STATE_TIP[state]}>
            {state}
          </td>
          <td>
            {hasUnapplied(w) && (
              <span className="s-ic ws-unapplied" title={UNAPPLIED} aria-label={UNAPPLIED}>
                <UnappliedIcon />
              </span>
            )}
          </td>
          {close && (
            <td className="ws-act">
              <Button kind="link" className="ws-close" disabled={busy === w.workspace} title={waiting ? CLOSE_WAITING : undefined} onClick={() => doClose(w.workspace)}>
                {waiting ? 'Closing…' : 'Close'}
              </Button>
            </td>
          )}
        </tr>
        {stalledAt !== undefined && err?.id !== w.workspace && (
          <tr className="ws-err-row">
            <td colSpan={cols} className="ws-err ws-stalled" role="status">
              {closeStalled(stalledAt, Date.now())}
            </td>
          </tr>
        )}
        {err?.id === w.workspace && (
          <tr className="ws-err-row">
            <td colSpan={cols} className="bad ws-err">
              {err.text}
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  };
  return (
    <>
      <div className="sub-h">Workspaces</div>
      <table className="grid rn-workspaces" aria-label="Workspaces">
        <thead>
          <tr>
            <th>Task</th>
            <th>Made</th>
            <th>State</th>
            <th title={UNAPPLIED}>Not applied</th>
            {close && <th aria-label="Close" />}
          </tr>
        </thead>
        <tbody>
          {rows.map(row)}
        </tbody>
      </table>
    </>
  );
};
