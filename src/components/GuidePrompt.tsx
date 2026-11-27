import React from 'react';
import { Button } from './Controls';
import { Dialog, DialogActions } from './Dialog';
import { PRODUCT } from '../words';

// The one-time question on a first visit: a new data folder with no agents
// and no sessions offers the setup guide before the person has to find it.
// Either answer marks it asked, so it never nags; the Guide row stays in the
// foot nav for anyone who changes their mind.
export const GuidePrompt: React.FC<{ onStart: () => void; onClose: () => void }> = ({ onStart, onClose }) => (
  <Dialog title={`Set up ${PRODUCT}?`} onClose={onClose} className="guide-prompt">
    <div className="nd-note">
      The setup guide walks through adding an agent, connecting a sign-in or key, and starting a session.
    </div>
    <DialogActions cancel={false}>
      <Button kind="secondary" className="dlg-cancel" onClick={onClose}>
        Not now
      </Button>
      <Button kind="primary" className="guide-start" onClick={onStart}>
        Start the guide
      </Button>
    </DialogActions>
  </Dialog>
);
