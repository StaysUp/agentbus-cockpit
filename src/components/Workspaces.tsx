import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CloseState, WorkspaceRow } from '../types';
import { FolderInfo, folderLabel } from '../data/folders';
import { formatAgo } from '../utils/format';
import { Button } from './Controls';
import { UnappliedIcon } from './Icons';
import { RUNNERS_POLL_MS } from './RunnersList';

// What the Runners page needs for its workspaces: the list, and Close.
export interface WorkspacesApi {
  list: () => Promise<WorkspaceRow[] | null>;
  close: (workspace: string) => Promise<CloseState>;
}

export const UNAPPLIED = 'Changes not applied yet';
export const CLOSE_WAITING = 'The close waits behind a turn in this workspace. Click to ask again.';

// The workspaces the page shows: sandbox ones whose copy is still there
// (Close is for a copy only), newest first. Undefined before the first read,
// null on a service without the route.
//
// closing holds the workspaces whose Close was asked here and that the service
// still lists open: the close waits behind a turn, or its reply has not been
// read back yet. A workspace leaves it once a read lists it closed (its row
// goes) or not at all. The list is what the service says, so a workspace a
// later turn copies again shows again.
export function useWorkspaces(api?: WorkspacesApi): {
  rows: WorkspaceRow[] | null | undefined;
  error: string | null;
  closing: ReadonlySet<string>;
  // Marks a workspace as being closed and reads the list again.
  onClosing: (workspace: string) => void;
} {
  const [rows, setRows] = useState<WorkspaceRow[] | null | undefined>(api ? undefined : null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<ReadonlySet<string>>(() => new Set());
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
          setClosing((s) => {
            if (s.size === 0) return s;
            const open = new Set((got ?? []).filter((w) => !w.closed).map((w) => w.workspace));
            const left = new Set([...s].filter((id) => open.has(id)));
            return left.size === s.size ? s : left;
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
  const open = rows
    ?.filter((w) => w.sandbox && !w.closed)
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  const onClosing = useCallback((id: string) => {
    setClosing((s) => new Set(s).add(id));
    reread.current();
  }, []);
  return { rows: rows === null ? null : open, error, closing, onClosing };
}

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
  folders?: FolderInfo[];
  close?: (workspace: string) => Promise<CloseState>;
  closing?: ReadonlySet<string>;
  onClosing: (workspace: string) => void;
}> = ({ rows, folders = [], close, closing, onClosing }) => {
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
        if (st.state === 'failed') setErr({ id, text: st.error || 'Close failed' });
        // closed, or still queued or running behind a turn: the row stays,
        // marked, until the service lists the workspace closed.
        else onClosing(id);
      },
      (e: unknown) => {
        setBusy(null);
        setErr({ id, text: e instanceof Error ? e.message : String(e) });
      }
    );
  };
  const cols = close ? 4 : 3;
  return (
    <>
      <div className="sub-h">Workspaces</div>
      <table className="grid rn-workspaces" aria-label="Workspaces">
        <thead>
          <tr>
            <th>Folder</th>
            <th>Made</th>
            <th title={UNAPPLIED}>Not applied</th>
            {close && <th aria-label="Close" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => {
            const { names, paths } = folderNames(w, folders);
            const waiting = !!closing?.has(w.workspace);
            return (
              <React.Fragment key={w.workspace}>
                <tr data-workspace={w.workspace}>
                  <td className="ws-n" title={paths || undefined}>
                    {names}
                  </td>
                  <td className="t ws-age" title={new Date(w.created).toLocaleString()}>
                    {formatAgo(w.created) || '—'}
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
                      <Button
                        kind="link"
                        className="ws-close"
                        disabled={busy === w.workspace}
                        title={waiting ? CLOSE_WAITING : undefined}
                        onClick={() => doClose(w.workspace)}
                      >
                        {busy === w.workspace || waiting ? 'Closing…' : 'Close'}
                      </Button>
                    </td>
                  )}
                </tr>
                {err?.id === w.workspace && (
                  <tr className="ws-err-row">
                    <td colSpan={cols} className="bad ws-err">
                      {err.text}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </>
  );
};
