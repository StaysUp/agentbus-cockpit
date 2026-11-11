import React, { useState } from 'react';
import { ShellRun } from '../types';

// Output longer than this many lines is folded: the first lines show, and a
// button shows the rest.
export const SHELL_FOLD_LINES = 12;

function clock(t: string): string {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// One "!" command in the conversation: the line, how it ended, its output
// (folded when long) and when. running: sent, not ended yet. error: the
// API's words when it did not run.
export const ShellEntry: React.FC<{ run?: ShellRun; line?: string; running?: boolean; error?: string; onEdit?: () => void }> = ({
  run,
  line,
  running,
  error,
  onEdit,
}) => {
  const [open, setOpen] = useState(false);
  // stdout, then stderr, on lines of their own.
  const out = run ? (run.stdout && run.stderr && !run.stdout.endsWith('\n') ? `${run.stdout}\n${run.stderr}` : run.stdout + run.stderr) : '';
  const text = out.replace(/\n$/, '');
  const lines = text.split('\n');
  const long = lines.length > SHELL_FOLD_LINES;
  const shown = long && !open ? lines.slice(0, SHELL_FOLD_LINES).join('\n') : text;
  const ok = run && run.exitCode === 0 && !run.timedOut;
  return (
    <div className={`shell${error ? ' failed' : ''}`} data-shell={run?.id ?? 'pending'}>
      <div className="sh-h">
        <code className="sh-line">$ {run?.line ?? line}</code>
        {run && (
          <span className={`sh-exit ${ok ? 'ok' : 'bad'}`}>{run.timedOut ? 'timed out' : `exit ${run.exitCode}`}</span>
        )}
        {running && <span className="sh-exit run">running…</span>}
        {run && (
          <span className="sh-meta dim">
            {seconds(run.durationMs)} · {clock(run.time)}
          </span>
        )}
      </div>
      {run && text !== '' && <pre className="sh-out">{shown}</pre>}
      {run && long && (
        <button type="button" className="sh-fold" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
      {run?.truncated && <div className="sh-note dim">Output cut at 64 KiB of {run.outputBytes} bytes.</div>}
      {error && (
        <div className="tb-foot">
          <span className="form-error">{error}</span>
          {onEdit && (
            <button type="button" className="pend-back" onClick={onEdit}>
              Edit
            </button>
          )}
        </div>
      )}
    </div>
  );
};
