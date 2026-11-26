import React, { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { CANCEL } from '../words';
import { Button } from './Controls';
import { Notice } from './Notice';

// Every dialog in the cockpit is this one shell: drawn over the window, a
// dialog role with its title as its name, Esc and a click outside close it,
// focus moves in and comes back after, and while busy nothing closes it (an
// answer would land on whatever came next). Cancel says "Cancel" in every
// dialog.

// The open dialogs, newest last: only the newest answers Esc, so a confirm
// opened over a form closes alone.
const stack: number[] = [];
let nextId = 0;

interface DialogCtx {
  close: () => void;
  busy: boolean;
}
const Ctx = createContext<DialogCtx>({ close: () => undefined, busy: false });

const FOCUSABLE = 'input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  title: React.ReactNode;
  // The name a screen reader gives it, when the title is not plain text.
  label?: string;
  onClose: () => void;
  // While true, Esc, a click outside and Cancel do nothing.
  busy?: boolean;
  // A question that needs an answer (a confirm): role alertdialog.
  alert?: boolean;
  className?: string;
  // Given, the box is a form and Enter submits it.
  onSubmit?: (e: React.FormEvent) => void;
  children: React.ReactNode;
}

export const Dialog: React.FC<DialogProps> = ({ title, label, onClose, busy = false, alert, className, onSubmit, children }) => {
  const box = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const [id] = useState(() => ++nextId);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    stack.push(id);
    const before = document.activeElement as HTMLElement | null;
    // Focus moves in: to a field marked autoFocus, else the first control.
    const el = box.current;
    if (el && !el.contains(document.activeElement)) {
      (el.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    }
    // On document, so it runs after the dialog's own fields (a Select closes
    // its menu first and marks the key) and before the cockpit's handler on
    // window, which leaves a marked key alone.
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return;
        e.preventDefault();
        if (!busyRef.current) closeRef.current();
      } else if (e.key === 'Tab' && box.current) {
        // Tab stays inside the dialog.
        const all = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
        if (all.length === 0) return;
        const first = all[0];
        const last = all[all.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const at = stack.indexOf(id);
      if (at >= 0) stack.splice(at, 1);
      // Focus goes back where it was, if that is still on the page.
      if (before && before.isConnected) before.focus();
    };
  }, [id]);

  const close = () => {
    if (!busyRef.current) closeRef.current();
  };
  const name = label ?? (typeof title === 'string' ? title : undefined);
  const props = {
    ref: (el: HTMLElement | null) => {
      box.current = el;
    },
    className: `new-dialog${className ? ` ${className}` : ''}`,
    role: alert ? 'alertdialog' : 'dialog',
    'aria-modal': true,
    // Named by its title: as aria-label when the title is plain text, so
    // the name is the same string a test or a screen reader looks for.
    'aria-labelledby': name ? undefined : titleId,
    'aria-label': name,
    'aria-busy': busy || undefined,
  } as const;
  const inner = (
    <>
      <div className="nd-title" id={titleId}>
        {title}
      </div>
      {children}
    </>
  );
  // Drawn where it is opened, fixed over the whole window at z-index 70:
  // no ancestor of a dialog sets a transform, so fixed is the window, and 70
  // is above the panel (50) and the narrow Agents menu (61).
  return (
    <Ctx.Provider value={{ close, busy }}>
      <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        {onSubmit ? (
          <form {...props} onSubmit={onSubmit}>
            {inner}
          </form>
        ) : (
          <div {...props}>{inner}</div>
        )}
      </div>
    </Ctx.Provider>
  );
};

// The dialog's row of actions, at the right: Cancel first, then the dialog's
// own buttons, so the main action is always the last one on the right.
// cancel={false} leaves Cancel out; a string names it (only for a dialog whose
// work is done, where it is the one action left, so it goes last).
export const DialogActions: React.FC<{ children?: React.ReactNode; cancel?: string | false; cancelFocus?: boolean }> = ({
  children,
  cancel,
  cancelFocus,
}) => {
  const { close, busy } = useContext(Ctx);
  const cancelButton =
    cancel === false ? null : (
      <Button kind="secondary" className="dlg-cancel" onClick={close} disabled={busy} data-autofocus={cancelFocus || undefined}>
        {cancel ?? CANCEL}
      </Button>
    );
  return (
    <div className="nd-actions">
      {typeof cancel !== 'string' && cancelButton}
      {children}
      {typeof cancel === 'string' && cancelButton}
    </div>
  );
};

// A confirm before a change that lasts: closing a session, removing a
// runner, a key or an agent. One line says what happens; Cancel has the
// focus, so Enter never removes by accident. onConfirm resolves to nothing
// when it worked (the dialog closes), or to a refusal to show; a rejection
// shows its words.
export const ConfirmDialog: React.FC<{
  title: string;
  line: React.ReactNode;
  // A warning above the buttons, such as files not applied yet.
  warn?: React.ReactNode;
  action: string;
  busyAction: string;
  onConfirm: () => Promise<string | void>;
  onClose: () => void;
  className?: string;
}> = ({ title, line, warn, action, busyAction, onConfirm, onClose, className }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const refused = await onConfirm();
      if (!alive.current) return;
      setBusy(false);
      if (refused) setError(refused);
      else onClose();
    } catch (err) {
      if (!alive.current) return;
      setBusy(false);
      setError((err as Error).message);
    }
  };
  return (
    <Dialog title={title} onClose={onClose} busy={busy} alert className={`confirm${className ? ` ${className}` : ''}`}>
      <div className="nd-note">{line}</div>
      {warn && (
        <Notice kind="warn" className="confirm-warn">
          {warn}
        </Notice>
      )}
      {error && (
        <Notice kind="error" className="confirm-refused">
          {error}
        </Notice>
      )}
      <DialogActions cancelFocus>
        <Button kind="primary" className="confirm-go" onClick={go} disabled={busy}>
          {busy ? busyAction : action}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
