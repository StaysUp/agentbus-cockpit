import React, { useEffect, useState } from 'react';
import { ApplyState, TurnDiff } from '../types';

interface ChangesDialogProps {
  turnNumber: number;
  loadDiff: () => Promise<TurnDiff>;
  // Absent when the source cannot apply.
  apply?: () => Promise<ApplyState>;
  onClose: () => void;
  // How often an apply still queued or running is read again, from the diff.
  pollMs?: number;
}

// One turn's changes, from GET /api/v0/turns/<id>/diff: each file with its
// diff, the commands the agent ran, and a button that applies the turn to
// the person's folder. A refusal is shown in the API's words, with each file.
// One dialog is one turn: the caller remounts it (a key) for another turn.
export const ChangesDialog: React.FC<ChangesDialogProps> = ({ turnNumber, loadDiff, apply, onClose, pollMs = 2000 }) => {
  const [diff, setDiff] = useState<TurnDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<ApplyState | null>(null);
  const [applying, setApplying] = useState(false);

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
      setApplied(await apply());
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
                <div key={f.path} className="ch-file">
                  <div className="ch-path">
                    <code>{f.path}</code> <span className={`ch-kind ${f.change}`}>{f.change}</span>
                  </div>
                  {f.diff ? (
                    <pre className="ch-diff">{f.diff}</pre>
                  ) : f.diff_left_out ? (
                    <div className="nd-note">No diff here: binary, too big, or its earlier content is not kept.</div>
                  ) : null}
                </div>
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
            <button type="button" className="connect-go" disabled={!canApply} onClick={doApply}>
              {applying ? 'Applying…' : 'Apply to my folder'}
            </button>
          )}
          <button type="button" className="use-recorded" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

// How many files an apply wrote or removed: count, when the list was cut.
function appliedCount(s: ApplyState): number {
  return Math.max(s.count ?? 0, s.files?.length ?? 0);
}
