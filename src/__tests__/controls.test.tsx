// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Checkbox, Combo, Select, Switch } from '../components/Controls';
import { click, render, selectIn, unmountAll } from './helpers';

afterEach(() => {
  unmountAll();
  document.body.innerHTML = '';
});

const key = async (el: Element, k: string) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
const menu = () => document.querySelector('[role="listbox"]');

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta', disabled: true },
  { value: 'c', label: 'Gamma', hint: 'quiet' },
];

const Picker: React.FC<{ onChange?: (v: string) => void }> = ({ onChange }) => {
  const [v, setV] = useState('a');
  return (
    <Select
      name="x"
      label="X"
      value={v}
      options={OPTIONS}
      onChange={(n) => {
        setV(n);
        onChange?.(n);
      }}
    />
  );
};

describe('Select', () => {
  it('opens a menu with a tick on the value, picks with a click, and closes', async () => {
    const onChange = vi.fn();
    const r = await render(<Picker onChange={onChange} />);
    const sel = selectIn(r.container, 'x')!;
    expect(sel.textContent).toBe('Alpha');
    expect(sel.getAttribute('aria-expanded')).toBe('false');
    await click(sel);
    expect(sel.getAttribute('aria-expanded')).toBe('true');
    const opts = [...menu()!.querySelectorAll('[role="option"]')] as HTMLButtonElement[];
    expect(opts.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(opts[0].querySelector('.ck')!.textContent).toBe('✓');
    expect(opts[1].disabled).toBe(true);
    await click(opts[2]);
    expect(onChange).toHaveBeenCalledWith('c');
    expect(menu()).toBeNull();
    expect(sel.value).toBe('c');
  });

  it('moves with the arrow keys past a disabled option, picks with Enter, and Escape closes the menu only', async () => {
    const outer = vi.fn();
    const r = await render(
      <div onKeyDown={(e) => e.key === 'Escape' && outer()}>
        <Picker />
      </div>
    );
    const sel = selectIn(r.container, 'x')!;
    await key(sel, 'ArrowDown'); // opens on the value
    expect(menu()).not.toBeNull();
    await key(sel, 'ArrowDown'); // Beta is disabled: Gamma
    expect(menu()!.querySelector('.act')!.textContent).toContain('Gamma');
    await key(sel, 'Enter');
    expect(sel.value).toBe('c');
    await key(sel, 'ArrowDown');
    await key(sel, 'Escape');
    expect(menu()).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    // With the menu shut, Escape goes on to the dialog around it.
    await key(sel, 'Escape');
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('closes on a click outside, and a disabled one does not open', async () => {
    const r = await render(
      <>
        <Picker />
        <Select name="y" label="Y" value="" placeholder="Pick one" options={OPTIONS} onChange={() => {}} disabled />
      </>
    );
    await click(selectIn(r.container, 'x'));
    expect(menu()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(menu()).toBeNull();
    const y = selectIn(r.container, 'y')!;
    expect(y.textContent).toBe('Pick one');
    expect(y.disabled).toBe(true);
  });
});

describe('Combo, Checkbox and Switch', () => {
  it('Combo suggests what matches the text, and a suggestion fills it', async () => {
    const Box: React.FC = () => {
      const [v, setV] = useState('');
      return <Combo name="m" label="Model" value={v} onChange={setV} suggestions={['sonnet', 'opus', 'haiku']} />;
    };
    const r = await render(<Box />);
    const input = r.container.querySelector('input[name="m"]') as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      input.focus();
    });
    expect([...menu()!.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-value'))).toEqual(['sonnet', 'opus', 'haiku']);
    await click(menu()!.querySelector('[data-value="opus"]'));
    expect(input.value).toBe('opus');
    expect(menu()).toBeNull();
  });

  it('Combo closes on Tab, and ArrowUp from no suggestion goes to the last', async () => {
    const Box: React.FC = () => {
      const [v, setV] = useState('');
      return <Combo name="m" label="Model" value={v} onChange={setV} suggestions={['sonnet', 'opus', 'haiku']} />;
    };
    const r = await render(<Box />);
    const input = r.container.querySelector('input[name="m"]') as HTMLInputElement;
    await act(async () => input.focus());
    expect(menu()).not.toBeNull();
    await key(input, 'Tab');
    expect(menu()).toBeNull();
    await key(input, 'ArrowUp');
    expect(menu()!.querySelector('.act')!.getAttribute('data-value')).toBe('haiku');
    await key(input, 'Enter');
    expect(input.value).toBe('haiku');
    expect(menu()).toBeNull();
  });

  it('Checkbox and Switch say their state and flip on a click', async () => {
    const Both: React.FC = () => {
      const [a, setA] = useState(false);
      const [b, setB] = useState(true);
      return (
        <>
          <Checkbox name="a" label="Read only" checked={a} onChange={setA} />
          <Switch name="b" label="On" on={b} onChange={setB} />
        </>
      );
    };
    const r = await render(<Both />);
    const a = r.container.querySelector('[name="a"]')!;
    const b = r.container.querySelector('[name="b"]')!;
    expect([a.getAttribute('role'), a.getAttribute('aria-checked')]).toEqual(['checkbox', 'false']);
    expect([b.getAttribute('role'), b.getAttribute('aria-checked')]).toEqual(['switch', 'true']);
    await click(a);
    await click(b);
    expect(a.getAttribute('aria-checked')).toBe('true');
    expect(b.getAttribute('aria-checked')).toBe('false');
  });
});

// The cockpit draws every control itself: no screen uses the browser's own
// select, checkbox, radio button or suggestion list.
describe('no browser-drawn controls', () => {
  it('no component writes a select, a checkbox or radio input, or a datalist', () => {
    const files = {
      ...import.meta.glob('../components/*.tsx', { query: '?raw', import: 'default', eager: true }),
      ...import.meta.glob('../*.tsx', { query: '?raw', import: 'default', eager: true }),
    } as Record<string, string>;
    expect(Object.keys(files).length).toBeGreaterThan(20);
    const found = Object.entries(files)
      .filter(([, src]) => /<select\b|<datalist\b|type=["'](checkbox|radio)["']/.test(src))
      .map(([f]) => f);
    expect(found).toEqual([]);
  });
});
