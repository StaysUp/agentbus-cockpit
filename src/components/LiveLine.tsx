import React from 'react';
import { LiveStatus } from '../data/liveStatus';

// One status line: a turning spinner while something runs, else a mark for
// how the turn ended. Used on the session card and in the chat.
export const LiveLine: React.FC<{ status: LiveStatus; className?: string }> = ({ status, className }) => {
  const cls = status.running ? 'run' : status.state === 'failed' ? 'bad' : 'dim';
  const mark = status.state === 'finished' ? '✓' : status.state === 'failed' ? '✕' : status.state === 'stopped' ? '■' : null;
  return (
    <span className={`live-line ${cls}${className ? ` ${className}` : ''}`} data-state={status.state}>
      {status.running ? <i className="spin run-spin" aria-hidden /> : mark ? <b className="mark">{mark}</b> : null}
      <span className="live-text">{status.line}</span>
    </span>
  );
};
