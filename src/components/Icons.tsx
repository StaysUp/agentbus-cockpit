import React from 'react';
import { Check, ChevronDown, ChevronRight, Copy, FileDiff, Lock, Plus, ShieldCheck, X } from 'lucide-react';

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

// UnappliedIcon marks a workspace with changes not applied to the folder yet.
export const UnappliedIcon: React.FC = () => <FileDiff size={13} strokeWidth={1.8} aria-hidden="true" />;

export const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button className="copy" onClick={handleCopy} title={copied ? 'Copied!' : 'Copy to clipboard'} aria-label="Copy">
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

// BusMark is the AgentBus logo: an orange bus with three navy windows and two
// white wheels, as on the site. It sits before the name in the left column.
export const BusMark: React.FC = () => (
  <svg className="bus-mark" width="22" height="17" viewBox="0 0 26 20" fill="none" aria-hidden="true">
    <rect x="1" y="2" width="24" height="13" rx="4" fill="#FE8919" />
    <rect x="4" y="5" width="5" height="4" rx="1" fill="#0B1F4D" />
    <rect x="10.5" y="5" width="5" height="4" rx="1" fill="#0B1F4D" />
    <rect x="17" y="5" width="5" height="4" rx="1" fill="#0B1F4D" />
    <circle cx="7" cy="16" r="2.6" fill="#FFFFFF" />
    <circle cx="19" cy="16" r="2.6" fill="#FFFFFF" />
  </svg>
);
