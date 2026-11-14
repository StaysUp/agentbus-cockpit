import React, { useEffect, useRef, useState } from 'react';
import { ApplyPreview, ApplyState, TurnDiff } from '../types';
import { PanelHead } from './PanelHead';

// A file as a turn's diff or the apply preview lists it. The preview counts
// its lines; a turn's diff is counted here.
interface ChangedFile {
  path: string;
  change: string;
  added?: number;
  removed?: number;
  diff?: string;
  diff_left_out?: boolean;
}

// Files changed by a conversation or a turn, each with its diff: added lines
// green, removed lines red, hunk headers quiet.

// Past this many files, each file starts folded to its name and counts.
const FOLD_OVER = 3;

const CONFLICT = 'you changed this file since; it would be refused';

// A copy past the framework's 200,000 files (MaxSnapshotFiles) gets cut-off
// checkpoints: its changes are not real and cannot be applied.
export const TOO_BIG = 'This folder is too big to track changes (over 200,000 files). Pick a smaller folder.';

// The preview, or an apply, refused because the copy had more files than a
// checkpoint holds (the framework's connector.ErrTruncated).
export function refusedTooBig(msg?: string | null): boolean {
  return !!msg && msg.includes('more files than a checkpoint holds');
}

// A turn's changes were cut because the copy was too big. truncated alone
// also means the list was cut (past 1,000 files, or to fit), so it counts
// only when every counted file is listed, or when the session's preview
// already said its copy is too big.
export function turnTooBig(f: { count: number; truncated?: boolean; changes: unknown[] } | null | undefined, sessionTooBig?: boolean): boolean {
  if (!f?.truncated) return false;
  return !!sessionTooBig || f.changes.length >= f.count;
}

// One changed file: its path, kind and line counts, and its diff, which
// scrolls sideways in its own box. A file the person changed since is
// marked: an apply would refuse it.
export const FileChange: React.FC<{ file: ChangedFile; open: boolean; conflict?: string }> = ({ file: f, open, conflict }) => {
  const lines = f.diff ? f.diff.replace(/\n$/, '').split('\n') : [];
  const added = f.added ?? lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = f.removed ?? lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  const counted = !!f.diff || (f.added ?? 0) + (f.removed ?? 0) > 0;
  return (
    <details className={`ch-file${conflict ? ' conflict' : ''}`} open={open}>
      <summary className="ch-path">
        <code>{f.path}</code> <span className={`ch-kind ${f.change}`}>{f.change}</span>
        {counted && (
          <span className="ch-count">
            <span className="ch-add">+{added}</span> <span className="ch-del">−{removed}</span>
          </span>
        )}
        {conflict && (
          <span className="ch-conflict" title={conflict}>
            {CONFLICT}
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

const FileList: React.FC<{ files: ChangedFile[]; truncated?: boolean; diffsCut?: boolean; conflicts?: Map<string, string> }> = ({
  files,
  truncated,
  diffsCut,
  conflicts,
}) => (
  <div className="ch-files">
    {files.map((f) => (
      <FileChange key={f.path} file={f} open={files.length <= FOLD_OVER} conflict={conflicts?.get(f.path)} />
    ))}
    {truncated && <div className="nd-note">More files changed than are listed.</div>}
    {diffsCut && <div className="nd-note">Some diffs are left out: the changes are too big to show in full.</div>}
  </div>
);

function lineKind(l: string): string {
  if (l.startsWith('+++') || l.startsWith('---')) return 'meta';
  if (l.startsWith('@@')) return 'hunk';
  if (l.startsWith('+')) return 'add';
  if (l.startsWith('-')) return 'del';
  if (l.startsWith('\\')) return 'meta';
  return 'ctx';
}

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

// The turn panel's Changes tab: what this one turn changed, read-only, from
// GET /api/v0/turns/<id>/diff. Applying is done for the whole conversation,
// from the bar above the message box.
export const TurnChangesTab: React.FC<{ turnId: string; loadDiff: () => Promise<TurnDiff>; tooBig?: boolean }> = ({
  turnId,
  loadDiff,
  tooBig,
}) => {
  const [diff, setDiff] = useState<{ turn: string; d: TurnDiff } | null>(null);
  const [error, setError] = useState<{ turn: string; msg: string } | null>(null);
  const loadRef = useRef(loadDiff);
  loadRef.current = loadDiff;
  useEffect(() => {
    let active = true;
    loadRef.current().then(
      (d) => active && setDiff({ turn: turnId, d }),
      (err) => active && setError({ turn: turnId, msg: (err as Error).message })
    );
    return () => {
      active = false;
    };
  }, [turnId]);
  const d = diff?.turn === turnId ? diff.d : null;
  const err = error?.turn === turnId ? error.msg : null;
  if (err) return <div className="form-error">{err}</div>;
  if (!d) return <p className="dim">Reading…</p>;
  const f = d.files;
  if (turnTooBig(f, tooBig)) {
    return (
      <div className="turn-changes">
        <div className="form-error too-big">{TOO_BIG}</div>
      </div>
    );
  }
  return (
    <div className="turn-changes">
      <div className="tab-sum">
        <b>{f && f.count > 0 ? files(f.count) : 'No files'}</b>
        <span className="sep"> · </span>
        {f && f.count > 0 ? 'changed by this turn' : 'this turn changed no files'}
        {d.commands.length > 0 && (
          <>
            <span className="sep"> · </span>
            {d.commands.length} {d.commands.length === 1 ? 'command' : 'commands'}
          </>
        )}
      </div>
      {f && f.count > 0 && <FileList files={f.changes} truncated={f.truncated} />}
      {d.commands.length > 0 && (
        <details className="ch-cmds">
          <summary>Commands</summary>
          <pre>{d.commands.join('\n')}</pre>
        </details>
      )}
    </div>
  );
};

interface ApplyPanelProps {
  // The conversation's preview: null while it is read the first time.
  preview: ApplyPreview | null;
  error?: string | null;
  // POST /api/v0/turns/<turn>/apply, and a read of that apply's state while
  // it is queued or running. Absent when the source cannot apply.
  apply?: (turn: string) => Promise<ApplyState>;
  readApply?: (turn: string) => Promise<ApplyState>;
  // Told when an apply ends, applied or not, so the preview is read again.
  onApplyEnded?: () => void;
  onClose?: () => void;
  pollMs?: number;
}

// The right panel's apply preview for the conversation on screen: every
// file applying would write, its diff against the person's folder now, any
// file the person changed since (which the apply would refuse), and one
// "Apply to my folder" for the turn the preview names.
export const ApplyPanel: React.FC<ApplyPanelProps> = ({ preview, error, apply, readApply, onApplyEnded, onClose, pollMs = 2000 }) => {
  // The apply this panel asked for: its turn, and its state as last read.
  const [asked, setAsked] = useState<{ turn: string; state: ApplyState | null } | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const endedRef = useRef(onApplyEnded);
  endedRef.current = onApplyEnded;

  const state = asked?.state;
  const pending = !!asked && (!state || state.state === 'queued' || state.state === 'running');

  const doApply = async () => {
    if (!apply || !preview?.turn) return;
    const turn = preview.turn;
    setAsked({ turn, state: null });
    setApplyError(null);
    try {
      const s = await apply(turn);
      setAsked({ turn, state: s });
      if (s.state !== 'queued' && s.state !== 'running') endedRef.current?.();
    } catch (err) {
      setAsked(null);
      setApplyError((err as Error).message);
    }
  };

  // An apply the API answered as queued or running ends later: read its
  // state again until it says how it ended.
  const polling = !!asked && !!state && (state.state === 'queued' || state.state === 'running') && !!readApply;
  useEffect(() => {
    if (!polling || !asked) return;
    let active = true;
    const turn = asked.turn;
    const id = setInterval(() => {
      readApply!(turn).then(
        (s) => {
          if (!active || s.state === 'queued' || s.state === 'running') return;
          setAsked({ turn, state: s });
          endedRef.current?.();
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
  }, [polling, asked, readApply, pollMs]);

  // After an apply, the panel says so until a later turn has new work.
  const applied = state?.state === 'applied' && (!preview || !preview.unapplied || preview.turn === asked!.turn);
  const refused = state && (state.state === 'refused' || state.state === 'failed') ? state : null;
  // The copy is too big to track: no count, no files, no apply.
  const tooBig = refusedTooBig(error) || refusedTooBig(refused?.error);
  // Each file an apply would refuse, by path.
  const conflicts = preview?.conflicts ?? [];
  const conflictOf = new Map(conflicts.map((c) => [c.path, c.why]));
  const conflicted = conflicts.length > 0;
  const has = !!preview && preview.unapplied && (preview.count > 0 || preview.files.length > 0 || conflicted);
  const canApply = !!apply && !!preview?.turn && has && !pending && !conflicted && !tooBig;

  return (
    <section id="right" className="apply-panel">
      <PanelHead up={[]} onClose={onClose}>
        {has && !applied ? 'Changes not applied' : 'Changes'}
      </PanelHead>
      <div id="d-body">
        {tooBig ? (
          <div className="form-error too-big">{TOO_BIG}</div>
        ) : (
          <>
            {error && <div className="form-error">{error}</div>}
            {!preview && !error && <p className="dim">Reading…</p>}
            {applied ? (
              <p className="nd-note ok" role="status">Applied. Your folder matches this conversation.</p>
            ) : (
              preview && (
                <>
                  <div className="tab-sum">
                    <b>{has ? files(preview.count || preview.files.length) : 'Nothing to apply'}</b>
                    <span className="sep"> · </span>
                    {has
                      ? 'would be written to your folder, each against what it holds now'
                      : preview.why || 'your folder matches this conversation'}
                  </div>
                  {conflicted && (
                    <div className="form-error ap-conflicts">
                      <b>{files(conflicts.length)} would be refused.</b> You changed{' '}
                      {conflicts.length === 1 ? 'this file' : 'these files'} in your folder since this conversation copied it:
                      <ul className="ch-conflicts">
                        {conflicts.map((c) => (
                          <li key={c.path}>
                            <code>{c.path}</code>: {c.why}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {has && (
                    <FileList files={preview.files} truncated={preview.truncated} diffsCut={preview.diffs_cut} conflicts={conflictOf} />
                  )}
                </>
              )
            )}
            {refused && (
              <div className="form-error">
                {refused.error || 'The apply was refused.'}
                {refused.conflicts && refused.conflicts.length > 0 && (
                  <ul className="ch-conflicts">
                    {refused.conflicts.map((c) => (
                      <li key={c.path}>
                        <code>{c.path}</code>: {c.why}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {applyError && <div className="form-error">{applyError}</div>}
            {apply && !applied && has && (
              <div className="ap-actions">
                <button type="button" className="btn btn-primary" disabled={!canApply} onClick={doApply}>
                  {pending ? 'Applying…' : 'Apply to my folder'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
};
