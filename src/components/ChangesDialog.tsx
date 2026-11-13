import React, { useEffect, useRef, useState } from 'react';
import { ApplyState, TurnDiff, TurnDiffFile } from '../types';

interface ChangesDialogProps {
  turnNumber: number;
  loadDiff: () => Promise<TurnDiff>;
  // Absent when the source cannot apply.
  apply?: () => Promise<ApplyState>;
  onClose: () => void;
  // Told once the turn is applied: by this dialog's apply, or when an apply
  // read again ends applied.
  onApplied?: () => void;
  // How often an apply still queued or running is read again, from the diff.
  pollMs?: number;
}

// One turn's changes, from GET /api/v0/turns/<id>/diff: each file with its
// diff, the commands the agent ran, and a button that applies the turn to
// the person's folder. A refusal is shown in the API's words, with each file.
// One dialog is one turn: the caller remounts it (a key) for another turn.
export const ChangesDialog: React.FC<ChangesDialogProps> = ({ turnNumber, loadDiff, apply, onClose, onApplied, pollMs = 2000 }) => {
  const [diff, setDiff] = useState<TurnDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<ApplyState | null>(null);
  const [applying, setApplying] = useState(false);
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;

  useEffect(() => {
    let active = true;
    loadDiff().then(
      (d) => active && setDiff(d),
      (err) => active && setError((err as Error).message)
    );
    return () => {
      active = false;
    };
  }, [loadDiff]);

  const doApply = async () => {
    if (!apply) return;
    setApplying(true);
    setError(null);
    try {
      const s = await apply();
      setApplied(s);
      if (s.state === 'applied') onAppliedRef.current?.();
    } catch (err) {
      setError((err as Error).message);
    }
    setApplying(false);
  };

  const state = applied ?? diff?.apply;
  // An apply the API answered as queued or running ends later: read the
  // diff again until its apply says how it ended.
  const pending = state?.state === 'queued' || state?.state === 'running';
  useEffect(() => {
    if (!pending) return;
    let active = true;
    const id = setInterval(() => {
      loadDiff().then(
        (d) => {
          if (!active || d.apply.state === 'queued' || d.apply.state === 'running') return;
          setDiff(d);
          setApplied(null);
          if (d.apply.state === 'applied') onAppliedRef.current?.();
        },
        () => {
          // A read that fails is tried again on the next tick.
        }
      );
    }, pollMs);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [pending, loadDiff, pollMs]);
  const files = diff?.files;
  const canApply = !!apply && !!files?.isolated && files.count > 0 && state?.state !== 'applied' && !pending && !applying;

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="new-dialog changes-dialog" role="dialog" aria-label={`Changes of turn ${turnNumber}`}>
        <div className="nd-title">Turn {turnNumber}: changes</div>
        {!diff && !error && <div className="nd-note">Reading…</div>}
        {diff && !files && <div className="nd-note">No file changes are recorded for this turn.</div>}
        {files && (
          <>
            <div className="nd-note">
              {files.count} {files.count === 1 ? 'file' : 'files'} · {diff!.model_calls.count} model calls · {diff!.commands.length}{' '}
              {diff!.commands.length === 1 ? 'command' : 'commands'}
              {!files.isolated && ' · not in an isolated copy, so it cannot be applied'}
            </div>
            <div className="ch-files">
              {files.changes.map((f) => (
                <FileChange key={f.path} file={f} open={files.changes.length <= FOLD_OVER} />
              ))}
              {files.truncated && <div className="nd-note">More files changed than are listed.</div>}
            </div>
          </>
        )}
        {diff && diff.commands.length > 0 && (
          <details className="ch-cmds">
            <summary>Commands</summary>
            <pre>{diff.commands.join('\n')}</pre>
          </details>
        )}
        {state && state.state === 'applied' && (
          <div className="nd-note ch-applied">
            {state.already ? 'Applied before.' : 'Applied to your folder.'} {appliedCount(state)}{' '}
            {appliedCount(state) === 1 ? 'file' : 'files'} written.
          </div>
        )}
        {state && (state.state === 'queued' || state.state === 'running') && <div className="nd-note">Applying…</div>}
        {state && (state.state === 'refused' || state.state === 'failed') && (
          <div className="form-error">
            {state.error}
            {state.conflicts && state.conflicts.length > 0 && (
              <ul className="ch-conflicts">
                {state.conflicts.map((c) => (
                  <li key={c.path}>
                    <code>{c.path}</code>: {c.why}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="nd-actions">
          {apply && (
            <button type="button" className="btn btn-primary connect-go" disabled={!canApply} onClick={doApply}>
              {applying ? 'Applying…' : 'Apply to my folder'}
            </button>
          )}
          <button type="button" className="btn btn-secondary nd-cancel" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

// Past this many files, each file starts folded to its name and counts.
const FOLD_OVER = 3;

// One changed file: its path, kind and line counts, and its diff with added
// lines green, removed lines red and hunk headers quiet. The diff scrolls
// sideways in its own box.
const FileChange: React.FC<{ file: TurnDiffFile; open: boolean }> = ({ file: f, open }) => {
  const lines = f.diff ? f.diff.replace(/\n$/, '').split('\n') : [];
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  return (
    <details className="ch-file" open={open}>
      <summary className="ch-path">
        <code>{f.path}</code> <span className={`ch-kind ${f.change}`}>{f.change}</span>
        {f.diff && (
          <span className="ch-count">
            <span className="ch-add">+{added}</span> <span className="ch-del">−{removed}</span>
          </span>
        )}
      </summary>
      {f.diff ? (
        <pre className="ch-diff">
          <span className="ch-lines">
            {lines.map((l, i) => (
              <span key={i} className={`dl ${lineKind(l)}`}>
                {l === '' ? ' ' : l}
              </span>
            ))}
          </span>
        </pre>
      ) : f.diff_left_out ? (
        <div className="nd-note">No diff here: binary, too big, or its earlier content is not kept.</div>
      ) : null}
    </details>
  );
};

function lineKind(l: string): string {
  if (l.startsWith('+++') || l.startsWith('---')) return 'meta';
  if (l.startsWith('@@')) return 'hunk';
  if (l.startsWith('+')) return 'add';
  if (l.startsWith('-')) return 'del';
  if (l.startsWith('\\')) return 'meta';
  return 'ctx';
}

// How many files an apply wrote or removed: count, when the list was cut.
function appliedCount(s: ApplyState): number {
  return Math.max(s.count ?? 0, s.files?.length ?? 0);
}
