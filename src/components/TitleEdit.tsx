import React, { useEffect, useRef, useState } from 'react';

interface TitleEditProps {
  title: string;
  // Saves the new title; rejects with the API's words.
  onSave: (title: string) => Promise<void>;
  onDone: () => void;
  className?: string;
}

// A session's name, edited in place: Enter saves, Escape cancels, and so does
// leaving the box. A refusal keeps the box open with the API's words under it.
// The box sets no length limit: the API counts characters as it does (120,
// by code point) and says so when a name is too long.
export const TitleEdit: React.FC<TitleEditProps> = ({ title, onSave, onDone, className }) => {
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read by the blur a disabled box fires while a save is in flight.
  const saving = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  // After a refusal the box is enabled again: give it the focus back.
  useEffect(() => {
    if (!busy && error) input.current?.focus();
  }, [busy, error]);

  const save = async () => {
    const t = value.trim();
    if (t === '' || t === title) {
      onDone();
      return;
    }
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSave(t);
      onDone();
    } catch (err) {
      saving.current = false;
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <span className={`title-edit ${className ?? ''}`} onClick={(e) => e.stopPropagation()}>
      <input
        ref={input}
        value={value}
        disabled={busy}
        aria-label="Session name"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          } else if (e.key === 'Escape') {
            // Handled here, so the app's Esc does not also close the panel.
            e.preventDefault();
            e.stopPropagation();
            onDone();
          }
        }}
        onBlur={() => {
          if (!saving.current) onDone();
        }}
      />
      {error && <span className="form-error">{error}</span>}
    </span>
  );
};

// The pencil that starts a rename.
export const PencilIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" strokeLinejoin="round" />
  </svg>
);
