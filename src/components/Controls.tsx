import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
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
  // A second line under the label. The row grows tall enough to wrap.
  detail?: React.ReactNode;
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
  // A detail line wraps inside the field's width, and stays on the screen.
  const wrap = options.some((o) => !!o.detail);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const h = menuRef.current?.offsetHeight ?? 0;
      const below = window.innerHeight - r.bottom;
      const up = h > below - 8 && r.top > below;
      const room = Math.max(160, window.innerWidth - 16);
      const width = Math.min(Math.max(r.width, 160), room);
      const left = align === 'right' ? Math.max(8, r.right - width) : Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
      setPos({
        position: 'fixed',
        left,
        minWidth: width,
        ...(wrap ? { width, maxWidth: room } : {}),
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
  }, [anchor, align, menuRef, wrap]);
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
              className={`menu-i${o.detail ? ' big' : ''}${i === active ? ' act' : ''}`}
              aria-selected={o.value === value}
              data-value={o.value}
              disabled={o.disabled}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(o.value)}
            >
              <span className="ck">{o.value === value ? '✓' : ''}</span>
              <span className="mi-l">
                {o.label}
                {o.detail && <span className="sub">{o.detail}</span>}
              </span>
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
    } else if (open && e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // A letter goes to the next option whose label starts with it.
      const k = e.key.toLowerCase();
      for (let n = 1; n <= options.length; n++) {
        const i = (active + n + options.length) % options.length;
        if (usable(i) && (typeof options[i].label === 'string' ? (options[i].label as string) : options[i].value).trim().toLowerCase().startsWith(k)) {
          e.preventDefault();
          setActive(i);
          break;
        }
      }
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

// One rich suggestion. Searched by its value, label and search text.
// detail is the second line on screen; it is not searched, so words that
// only decorate that line (a price's "in" and "out") do not match every row.
// A group with no match is absent, because only its options carry the heading.
export interface ComboChoice {
  value: string;
  label: string;
  detail?: string;
  group?: string;
  search?: string;
}

// Bring the active choices row into the menu. A row already fully inside
// the menu is left where it is. scrollIntoView is the common path; setting
// scrollTop covers an environment that has no such method.
function revealActiveRow(menu: HTMLElement, row: HTMLElement): void {
  const menuBox = menu.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  if (rowBox.height > 0 && rowBox.top >= menuBox.top && rowBox.bottom <= menuBox.bottom) return;
  const byScroll = () => {
    const top = row.offsetTop;
    const height = row.offsetHeight || rowBox.height;
    if (rowBox.top < menuBox.top) menu.scrollTop = top;
    else menu.scrollTop = Math.max(0, top + height - menu.clientHeight);
  };
  if (typeof row.scrollIntoView !== 'function') {
    byScroll();
    return;
  }
  try {
    row.scrollIntoView({ block: 'nearest' });
  } catch {
    byScroll();
  }
}

// Combo is a text field with suggestions in the same menu: any text may be
// typed, and a suggestion fills the field. choices, when passed, is that
// list instead of suggestions and labels.
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
  choices?: ComboChoice[];
}> = ({ name, label, value, suggestions, onChange, placeholder, disabled, className, labels, choices }) => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // The list filters by what the person typed since it opened, never by a
  // value picked from it; a pick closes it, and focus returning does not
  // open it again.
  const [typed, setTyped] = useState(false);
  const picked = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The choices row an arrow key just moved to. The menu may not be in the
  // document yet (the key also opens it), so the scroll waits for layout.
  const arrowScroll = useRef<number | null>(null);
  const q = typed ? value.trim().toLowerCase() : '';
  const options: Option[] = choices
    ? choices
        .filter((c) => {
          if (!q) return true;
          if (c.value.toLowerCase() === q) return false;
          return [c.label, c.value, c.search ?? ''].join('\n').toLowerCase().includes(q);
        })
        .map((c) => ({ value: c.value, label: c.label, detail: c.detail || undefined, group: c.group }))
    : suggestions
        .filter((s) => !q || ((s.toLowerCase().includes(q) || !!labels?.[s]?.toLowerCase().includes(q)) && s.toLowerCase() !== q))
        .map((s) => (labels?.[s] ? { value: s, label: labels[s], hint: s } : { value: s, label: s }));
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
  useLayoutEffect(() => {
    const index = arrowScroll.current;
    if (!choices || index === null) return;
    arrowScroll.current = null;
    const menu = menuRef.current;
    const row = menu?.querySelectorAll<HTMLElement>('[role="option"]')[index];
    if (!menu || !row) return;
    revealActiveRow(menu, row);
  }, [active, open, choices]);
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
        onFocus={() => {
          if (picked.current) {
            picked.current = false;
            return;
          }
          setTyped(false);
          setOpen(true);
        }}
        // A click on the field opens the list again after Escape or a pick
        // closed it; focus alone does not come again then.
        onClick={() => {
          if (open || disabled) return;
          setTyped(false);
          setOpen(true);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setTyped(true);
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
            // From no option: down is the first, up the last. The ends wrap.
            if (!n) return;
            const next = active < 0 ? (down ? 0 : n - 1) : (active + (down ? 1 : -1) + n) % n;
            if (choices) arrowScroll.current = next;
            setActive(next);
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
            picked.current = true;
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
  // What on means, in a few words, as its tooltip.
  title?: string;
}> = ({ name, label, on, onChange, disabled, className, title }) => (
  <button
    type="button"
    role="switch"
    name={name}
    title={title}
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

// Button is every button with words in the cockpit, in one of four looks:
// "primary" is the one main action of a form or a step (ink), "secondary"
// any other action beside it (white, outlined), "quiet" an action in a
// column header (no fill until hovered), "link" a text action inside a line
// (grey, underlined). small is for a button inside a line of text or a card.
// A link that looks like a button takes the same classes through
// buttonClass.
//
// Send and Stop under the message box are the one exception (.go): the
// mockup's ink button joined to the "how to send" menu as one split control,
// whose size and corners the four looks do not have.
export type ButtonKind = 'primary' | 'secondary' | 'quiet' | 'link';

export const buttonClass = (kind: ButtonKind, small?: boolean, className?: string) =>
  `${kind === 'link' ? 'link-btn' : `btn btn-${kind}${small ? ' btn-sm' : ''}`}${className ? ` ${className}` : ''}`;

// accent marks the one orange action of a screen (Apply): a primary button in
// the accent colour. Orange is for the moment, so at most one per screen.
export const Button: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { kind: ButtonKind; small?: boolean; accent?: boolean }
> = ({ kind, small, accent, className, type = 'button', ...rest }) => (
  <button type={type} className={buttonClass(kind, small, accent ? `btn-accent${className ? ` ${className}` : ''}` : className)} {...rest} />
);

// FoldButton folds a side column to a thin strip and back. The icon points the
// way the column will move.
export const FoldButton: React.FC<{ folded: boolean; name: string; onToggle: () => void }> = ({ folded, name, onToggle }) => (
  <button
    type="button"
    className="icon-btn col-fold"
    onClick={onToggle}
    aria-expanded={!folded}
    aria-label={folded ? `Show ${name}` : `Hide ${name}`}
    title={folded ? `Show ${name}` : `Hide ${name}`}
  >
    {folded ? <PanelLeftOpen size={16} strokeWidth={1.8} aria-hidden="true" /> : <PanelLeftClose size={16} strokeWidth={1.8} aria-hidden="true" />}
  </button>
);
