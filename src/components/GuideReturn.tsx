import React from 'react';
import { BookOpen, X } from 'lucide-react';

// The way back to the setup guide after one of its steps sent the person to
// another page. It stays out of the way at the foot of the window, shows how
// many steps are done, and can be put away for this visit.
export const GuideReturn: React.FC<{
  done: number;
  total: number;
  onOpen: () => void;
  onDismiss: () => void;
}> = ({ done, total, onOpen, onDismiss }) => (
  <div className="guide-return" data-guide-return>
    <button
      type="button"
      className="gr-open"
      onClick={onOpen}
      aria-label={`Return to the setup guide, ${done} of ${total} steps done`}
    >
      <BookOpen size={16} strokeWidth={1.8} aria-hidden="true" />
      <span className="gr-t">Setup guide</span>
      <span className="gr-p">
        {done} of {total}
      </span>
    </button>
    <button type="button" className="gr-x" onClick={onDismiss} aria-label="Dismiss the setup guide shortcut" title="Dismiss">
      <X size={14} strokeWidth={2.2} aria-hidden="true" />
    </button>
  </div>
);
