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

// One "!" command in the conversation: the line, then its state. sending:
// not answered yet. queued and running: from its events. ran: how it ended,
// its output (folded when long) and when. failed, or error: why, in the
// API's words; Edit (onEdit) puts a refused one back in the box.
export const ShellEntry: React.FC<{ run?: ShellRun; line?: string; sending?: boolean; error?: string; onEdit?: () => void }> = ({
  run,
  line,
  sending,
  error,
  onEdit,
}) => {
  const [open, setOpen] = useState(false);
  const done = run?.state === 'ran' ? run : undefined;
  // stdout, then stderr, on lines of their own.
  const out = done ? (done.stdout && done.stderr && !done.stdout.endsWith('\n') ? `${done.stdout}\n${done.stderr}` : done.stdout + done.stderr) : '';
  const text = out.replace(/\n$/, '');
  const lines = text.split('\n');
  const long = lines.length > SHELL_FOLD_LINES;
  const shown = long && !open ? lines.slice(0, SHELL_FOLD_LINES).join('\n') : text;
  const ok = done && done.exitCode === 0 && !done.timedOut;
  const why = error ?? (run?.state === 'failed' ? run.error ?? 'the command did not run' : undefined);
  return (
    <div className={`shell${why ? ' failed' : ''}`} data-shell={run?.id ?? 'pending'} data-state={run?.state ?? (error ? 'refused' : 'sending')}>
      <div className="sh-h">
        <code className="sh-line">$ {run?.line ?? line}</code>
        {done && <span className={`sh-exit ${ok ? 'ok' : 'bad'}`}>{done.timedOut ? 'timed out' : `exit ${done.exitCode}`}</span>}
        {sending && <span className="sh-exit run">sending</span>}
        {run?.state === 'queued' && <span className="sh-exit run">queued</span>}
        {run?.state === 'running' && <span className="sh-exit run">running…</span>}
        {run?.state === 'failed' && <span className="sh-exit bad">did not run</span>}
        {done && (
          <span className="sh-meta dim">
            {seconds(done.durationMs)} · {clock(done.time)}
          </span>
        )}
      </div>
      {done && text !== '' && <pre className="sh-out">{shown}</pre>}
      {done && long && (
        <button type="button" className="sh-fold" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
      {done?.truncated && <div className="sh-note dim">Output cut at 64 KiB of {done.outputBytes} bytes.</div>}
      {why && (
        <div className="tb-foot">
          <span className="form-error">{why}</span>
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
