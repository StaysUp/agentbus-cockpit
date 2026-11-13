import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Switch } from './Controls';

// Where the Feedback box sends: the Lorebug site's one endpoint
// (agentbus web/functions/api/feedback.js). It stores one row per message.
export const FEEDBACK_URL = 'https://lorebug.art/api/feedback';
export const DISCUSSIONS_URL = 'https://github.com/StaysUp/agentbus/discussions';

// The endpoint's limits, so a long message is stopped here, not refused there.
const MAX_MESSAGE = 4000;
const MAX_EMAIL = 254;

interface FeedbackDialogProps {
  // The AgentBus build, sent with the message; undefined when unknown.
  version?: string;
  onClose: () => void;
}

// The Feedback box: a message, an optional email and one switch. It sends
// exactly those and the AgentBus version, nothing from sessions, code,
// prompts or folders. When sending fails it says why (the site's own words
// when it answered), keeps the text to copy and send again, and links GitHub
// Discussions. Escape closes it, before the cockpit behind it sees the key.
export const FeedbackDialog: React.FC<FeedbackDialogProps> = ({ version, onClose }) => {
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [wantsHosted, setWantsHosted] = useState(false);
  const [state, setState] = useState<'edit' | 'sending' | 'sent' | 'failed'>('edit');
  // The site's own words for a refusal; null when it could not be reached.
  const [refusal, setRefusal] = useState<string | null>(null);

  // A capture listener on window runs before the cockpit's own Escape
  // handler, which leaves alone a key whose default is prevented.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || state === 'sending') return;
    setState('sending');
    const body = {
      message: message.trim(),
      email: email.trim(),
      wants_hosted: wantsHosted,
      version: (version ?? '').slice(0, 40),
    };
    try {
      const res = await fetch(FEEDBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (res.ok) {
        setState('sent');
        return;
      }
      setRefusal(await refusalText(res));
      setState('failed');
    } catch {
      setRefusal(null);
      setState('failed');
    }
  };

  return createPortal(
    <div className="modal-back feedback-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="new-dialog feedback-dialog" role="dialog" aria-modal="true" aria-label="Feedback" onSubmit={send}>
        <div className="nd-title">Feedback</div>
        {state === 'sent' ? (
          <>
            <div className="fb-done">Thanks — sent.</div>
            <div className="nd-actions">
              <button type="button" className="btn btn-secondary nd-cancel" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <label>
              <span>What's missing or broken?</span>
              <textarea
                name="message"
                rows={5}
                maxLength={MAX_MESSAGE}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                autoFocus
              />
            </label>
            <label>
              <span>Email (optional)</span>
              <input
                type="email"
                name="email"
                maxLength={MAX_EMAIL}
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <Switch
              className="fb-hosted"
              name="wants_hosted"
              label="Tell me when hosted Lorebug is ready"
              on={wantsHosted}
              onChange={setWantsHosted}
            />
            <div className="nd-note fb-what">This sends your message, and your email if given, to Lorebug.</div>
            {state === 'failed' && (
              <div className="form-error fb-failed" role="alert">
                {refusal ? `It was not sent: ${refusal}` : 'It could not be sent.'} Your message is still in the box
                above: copy it, or post it on{' '}
                <a href={DISCUSSIONS_URL} target="_blank" rel="noreferrer">
                  GitHub Discussions
                </a>
                .
              </div>
            )}
            <div className="nd-actions">
              <button type="submit" className="btn btn-primary fb-send" disabled={!message.trim() || state === 'sending'}>
                {state === 'sending' ? 'Sending…' : state === 'failed' ? 'Send again' : 'Send'}
              </button>
              <button type="button" className="btn btn-secondary nd-cancel" onClick={onClose}>
                {state === 'failed' ? 'Close' : 'Cancel'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>,
    document.body
  );
};

// refusalText is the site's {"error": "..."} when it gave one, else its
// status, so a refusal is told in the site's own words.
async function refusalText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) return body.error.trim().slice(0, 200);
  } catch {
    // Not JSON: the status says what happened.
  }
  return `the site answered ${res.status}.`;
}
