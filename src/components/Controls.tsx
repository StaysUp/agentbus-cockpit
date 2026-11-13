import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DownIcon } from './Icons';

// The cockpit's own controls. Every select, checkbox, switch and segmented
// choice in the cockpit is one of these, so they look and behave the same
// everywhere and the browser draws none of its own. The look is the turn
// view's picker (mockup v4): a box with the value and a chevron, and a menu
// of options with a tick on the chosen one.

export interface Option {
  value: string;
  label: React.ReactNode;
  // A quiet second part on the option's line, such as a model's provider.
  hint?: React.ReactNode;
  disabled?: boolean;
  // A group heading shown above the first option of each group.
  group?: string;
}

// The menu, drawn over everything at the trigger's place, so a dialog that
// scrolls never cuts it off. It opens upward when there is no room below.
const Menu: React.FC<{
  anchor: HTMLElement;
  label: string;
  options: Option[];
  value: string;
  active: number;
  setActive: (i: number) => void;
  onPick: (v: string) => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  align?: 'left' | 'right';
}> = ({ anchor, label, options, value, active, setActive, onPick, menuRef, align }) => {
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const h = menuRef.current?.offsetHeight ?? 0;
      const below = window.innerHeight - r.bottom;
      const up = h > below - 8 && r.top > below;
      const width = Math.max(r.width, 160);
      const left = align === 'right' ? Math.max(8, r.right - width) : Math.min(r.left, window.innerWidth - width - 8);
      setPos({
        position: 'fixed',
        left,
        minWidth: width,
        // Both set: the stylesheet's .menu has a top of its own.
        ...(up ? { top: 'auto', bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4, bottom: 'auto' }),
        maxHeight: Math.max(120, (up ? r.top : below) - 16),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, align, menuRef]);
  let group: string | undefined;
  return createPortal(
    <div className="menu ctl-menu" role="listbox" aria-label={label} ref={menuRef} style={pos}>
      {options.map((o, i) => {
        const head = o.group && o.group !== group ? o.group : undefined;
        group = o.group;
        return (
          <React.Fragment key={o.value}>
            {head && <div className="menu-g">{head}</div>}
            <button
              type="button"
              role="option"
              className={`menu-i${i === active ? ' act' : ''}`}
              aria-selected={o.value === value}
              data-value={o.value}
              disabled={o.disabled}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(o.value)}
            >
              <span className="ck">{o.value === value ? '✓' : ''}</span>
              <span className="mi-l">{o.label}</span>
              {o.hint && <span className="tag">{o.hint}</span>}
            </button>
          </React.Fragment>
        );
      })}
    </div>,
    document.body,
  );
};

// Select picks one of a few options. The trigger is a button with the
// field's name and value, so a form's [name] finds it. Variants: "field" is
// a bordered box as in a form; "quiet" is text and a chevron, for a bar
// such as the reply box; "icon" is the chevron alone, for a split button.
export const Select: React.FC<{
  name?: string;
  label: string;
  value: string;
  options: Option[];
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  variant?: 'field' | 'quiet' | 'icon';
  className?: string;
  title?: string;
  align?: 'left' | 'right';
}> = ({ name, label, value, options, onChange, placeholder, disabled, variant = 'field', className, title, align }) => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const btn = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const chosen = options.find((o) => o.value === value);
  const usable = (i: number) => i >= 0 && i < options.length && !options[i].disabled;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btn.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const show = () => {
    const i = options.findIndex((o) => o.value === value);
    setActive(usable(i) ? i : options.findIndex((o) => !o.disabled));
    setOpen(true);
    // Keys go to the trigger: some browsers do not focus a button on a click.
    btn.current?.focus();
  };
  const pick = (v: string) => {
    setOpen(false);
    btn.current?.focus();
    if (v !== value) onChange(v);
  };
  const step = (d: number) => {
    let i = active;
    for (let n = 0; n < options.length; n++) {
      i = (i + d + options.length) % options.length;
      if (usable(i)) return setActive(i);
    }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) show();
      else step(e.key === 'ArrowDown' ? 1 : -1);
    } else if ((e.key === 'Enter' || e.key === ' ') && open) {
      e.preventDefault();
      if (usable(active)) pick(options[active].value);
    } else if (e.key === 'Tab' && open) {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        type="button"
        ref={btn}
        role="combobox"
        name={name}
        value={value}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={title}
        disabled={disabled}
        className={`ctl-select ${variant}${open ? ' open' : ''}${chosen ? '' : ' empty'}${className ? ` ${className}` : ''}`}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
      >
        {variant !== 'icon' && <span className="cs-v">{chosen ? chosen.label : (placeholder ?? '')}</span>}
        <DownIcon />
      </button>
      {open && btn.current && (
        <Menu
          anchor={btn.current}
          label={label}
          options={options}
          value={value}
          active={active}
          setActive={setActive}
          onPick={pick}
          menuRef={menuRef}
          align={align}
        />
      )}
    </>
  );
};

// Combo is a text field with suggestions in the same menu: any text may be
// typed, and a suggestion fills the field.
export const Combo: React.FC<{
  name: string;
  label: string;
  value: string;
  suggestions: string[];
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  // A suggestion's name for a screen, by its value, such as a model's label:
  // shown with the value beside it, and searched too.
  labels?: Record<string, string>;
}> = ({ name, label, value, suggestions, onChange, placeholder, disabled, className, labels }) => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const q = value.trim().toLowerCase();
  const list = suggestions.filter(
    (s) => !q || ((s.toLowerCase().includes(q) || !!labels?.[s]?.toLowerCase().includes(q)) && s.toLowerCase() !== q),
  );
  const options: Option[] = list.map((s) => (labels?.[s] ? { value: s, label: labels[s], hint: s } : { value: s, label: s }));
  const shown = open && options.length > 0 && !disabled;
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (input.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <>
      <input
        ref={input}
        name={name}
        type="text"
        aria-label={label}
        role="combobox"
        aria-expanded={shown}
        aria-autocomplete="list"
        className={className}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && shown) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
            const n = options.length;
            const down = e.key === 'ArrowDown';
            // From no option: down is the first, up the last.
            if (n) setActive((i) => (i < 0 ? (down ? 0 : n - 1) : (i + (down ? 1 : -1) + n) % n));
          } else if (e.key === 'Tab') {
            setOpen(false);
          } else if (e.key === 'Enter' && shown && active >= 0 && active < options.length) {
            e.preventDefault();
            onChange(options[active].value);
            setOpen(false);
          }
        }}
      />
      {shown && input.current && (
        <Menu
          anchor={input.current}
          label={label}
          options={options}
          value={value}
          active={active}
          setActive={setActive}
          onPick={(v) => {
            onChange(v);
            setOpen(false);
            input.current?.focus();
          }}
          menuRef={menuRef}
        />
      )}
    </>
  );
};

// Switch is on or off, in the mockup's look. It is the cockpit's one
// control for a yes or a no: never a select, a checkbox or a two-way Seg.
export const Switch: React.FC<{
  name?: string;
  label: React.ReactNode;
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
}> = ({ name, label, on, onChange, disabled, className }) => (
  <button
    type="button"
    role="switch"
    name={name}
    aria-checked={on}
    disabled={disabled}
    className={`ctl-switch${className ? ` ${className}` : ''}`}
    onClick={() => onChange(!on)}
  >
    <span className={`sw${on ? ' on' : ''}`} aria-hidden="true" />
    <span>{label}</span>
  </button>
);

// Seg is one choice of a few, side by side.
export interface SegOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
  title?: string;
}

export const Seg: React.FC<{
  label: string;
  value: string;
  options: SegOption[];
  onChange: (v: string) => void;
  // The attribute each option carries its value in, for tests and styles.
  dataKey?: string;
}> = ({ label, value, options, onChange, dataKey }) => (
  <span className="nd-seg" role="radiogroup" aria-label={label}>
    {options.map((o) => (
      <button
        type="button"
        role="radio"
        key={o.value}
        {...(dataKey ? { [`data-${dataKey}`]: o.value } : {})}
        aria-checked={value === o.value}
        className={value === o.value ? 'on' : ''}
        disabled={o.disabled}
        title={o.title}
        onClick={() => onChange(o.value)}
      >
        {o.label}
      </button>
    ))}
  </span>
);

// Button is every button with words in the cockpit, in one of three looks:
// "primary" is the one main action of a form or a step (ink), "secondary"
// any other action beside it (white, outlined), "quiet" an action in a
// column header (no fill until hovered). small is for a button inside a
// line of text or a card. A link that looks like a button takes the same
// classes through buttonClass.
export type ButtonKind = 'primary' | 'secondary' | 'quiet';

export const buttonClass = (kind: ButtonKind, small?: boolean, className?: string) =>
  `btn btn-${kind}${small ? ' btn-sm' : ''}${className ? ` ${className}` : ''}`;

export const Button: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { kind: ButtonKind; small?: boolean }
> = ({ kind, small, className, type = 'button', ...rest }) => (
  <button type={type} className={buttonClass(kind, small, className)} {...rest} />
);
