import React from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Lock, Plus, ShieldCheck, X } from 'lucide-react';

// The cockpit's icons, from Lucide (thin-stroke, ISC), re-exported under the
// cockpit's own names so callers do not change. Sizes match the hand-drawn
// originals they replaced; colour is currentColor.

export const ChevIcon: React.FC = () => <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />;

export const DownIcon: React.FC = () => <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />;

export const PlusIcon: React.FC = () => <Plus size={12} strokeWidth={2} aria-hidden="true" />;

export const CopyIcon: React.FC = () => <Copy size={12} strokeWidth={1.7} aria-hidden="true" />;

export const TickIcon: React.FC = () => <Check size={13} strokeWidth={2.5} aria-hidden="true" />;

export const CloseIcon: React.FC = () => <X size={16} strokeWidth={2.2} aria-hidden="true" />;

// LockIcon marks a closed or archived conversation: it takes no more messages,
// or is hidden from the list.
export const LockIcon: React.FC = () => <Lock size={13} strokeWidth={1.8} aria-hidden="true" />;

export const CopyButton: React.FC<{ text: string; label?: string }> = ({ text, label = 'Copy' }) => {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button className="copy" onClick={handleCopy} title={copied ? 'Copied!' : label} aria-label={label}>
      {copied ? <TickIcon /> : <CopyIcon />}
    </button>
  );
};

// One slot for a session's status marks, right after its name, the same in the
// list card and the conversation header: the running dot (as today), a shield
// for a sandbox session (a copy of the folder), and a lock when it is archived
// or closed. Each has its own tooltip. Colour and size are the muted tokens.
export const SessionStatus: React.FC<{ running?: boolean; sandbox?: boolean; lock?: string | null }> = ({
  running,
  sandbox,
  lock,
}) => {
  if (!running && !sandbox && !lock) return null;
  return (
    <span className="s-icons">
      {running ? <i className="live" title="Running" aria-label="Running" /> : null}
      {sandbox ? (
        <span className="s-ic s-sandbox" title="Sandbox: runs in a copy of the folder; apply its changes when ready" aria-label="Sandbox">
          <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" />
        </span>
      ) : null}
      {lock ? (
        <span className="s-ic s-lock" title={lock} aria-label={lock}>
          <Lock size={14} strokeWidth={1.8} aria-hidden="true" />
        </span>
      ) : null}
    </span>
  );
};
