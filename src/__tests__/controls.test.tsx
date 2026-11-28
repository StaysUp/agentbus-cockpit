// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, Combo, Select, Switch } from '../components/Controls';
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

  it('a letter moves to the next option it starts, past a disabled one, and wraps', async () => {
    const r = await render(
      <Select
        name="z"
        label="Z"
        value="a"
        options={[...OPTIONS, { value: 'd', label: 'Gold' }, { value: 'e', label: 'beta two' }]}
        onChange={() => {}}
      />
    );
    const sel = selectIn(r.container, 'z')!;
    await click(sel);
    const act_ = () => menu()!.querySelector('.act')!.textContent;
    await key(sel, 'g');
    expect(act_()).toContain('Gamma');
    await key(sel, 'G');
    expect(act_()).toContain('Gold');
    await key(sel, 'g');
    expect(act_()).toContain('Gamma');
    // Beta is disabled: b goes to "beta two".
    await key(sel, 'b');
    expect(act_()).toContain('beta two');
    // No option starts with q: the active one stays.
    await key(sel, 'q');
    expect(act_()).toContain('beta two');
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

describe('Combo, Switch and Button', () => {
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

  it('Combo choices search the extra text, keep groups that match, and fill the value', async () => {
    const Box: React.FC = () => {
      const [v, setV] = useState('');
      return (
        <Combo
          name="m"
          label="Model"
          value={v}
          onChange={setV}
          suggestions={['ignored']}
          choices={[
            { value: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', detail: 'deepseek/deepseek-v4.1-flash · DeepSeek · 1,048,576 · $0.14 in · $0.42 out', group: 'Suggested', search: 'DeepSeek V4.1 Flash\nDeepSeek: DeepSeek V4.1 Flash\ndeepseek/deepseek-v4.1-flash\nDeepSeek\ndeepseek' },
            { value: 'x-ai/grok-4.7', label: 'Grok 4.7', detail: 'x-ai/grok-4.7 · SpaceXSI · 256,000 · $2.50 in · $10 out', group: 'All models', search: 'Grok 4.7\nSpaceXSI: Grok 4.7\nx-ai/grok-4.7\nSpaceXSI\nx-ai' },
          ]}
        />
      );
    };
    const r = await render(<Box />);
    const input = r.container.querySelector('input[name="m"]') as HTMLInputElement;
    await act(async () => input.focus());
    expect([...menu()!.querySelectorAll('.menu-g')].map((g) => g.textContent)).toEqual(['Suggested', 'All models']);
    expect(menu()!.querySelector('[data-value="deepseek/deepseek-v4.1-flash"]')!.textContent).toContain('$0.14 in · $0.42 out');
    const type = async (value: string) => {
      await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    const menus = () => document.querySelectorAll('[role="listbox"]').length;
    const openBefore = menus();
    await type('in');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(menus()).toBe(openBefore - 1);
    await type('out');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    await type('spacex');
    expect([...menu()!.querySelectorAll('.menu-g')].map((g) => g.textContent)).toEqual(['All models']);
    expect([...menu()!.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-value'))).toEqual(['x-ai/grok-4.7']);
    await click(menu()!.querySelector('[data-value="x-ai/grok-4.7"]'));
    expect(input.value).toBe('x-ai/grok-4.7');
    expect(menu()).toBeNull();
  });

  const richChoices = [
    { value: 'm0', label: 'Model 0', detail: 'm0 · Provider · 1,000 · $1 in · $2 out', group: 'Suggested', search: 'Model 0\nm0\nProvider' },
    { value: 'm1', label: 'Model 1', detail: 'm1 · Provider · 1,000 · $1 in · $2 out', group: 'Suggested', search: 'Model 1\nm1\nProvider' },
    { value: 'm2', label: 'Model 2', detail: 'm2 · Provider · 1,000 · $1 in · $2 out', group: 'All models', search: 'Model 2\nm2\nProvider' },
    { value: 'm3', label: 'Model 3', detail: 'm3 · Provider · 1,000 · $1 in · $2 out', group: 'All models', search: 'Model 3\nm3\nProvider' },
  ];

  it('Combo choices move with the arrows, wrap at the ends, and Enter selects the active row', async () => {
    const Box: React.FC = () => {
      const [v, setV] = useState('');
      return <Combo name="m" label="Model" value={v} onChange={setV} suggestions={['ignored']} choices={richChoices} />;
    };
    const r = await render(<Box />);
    const input = r.container.querySelector('input[name="m"]') as HTMLInputElement;
    await act(async () => input.focus());
    await key(input, 'ArrowDown');
    expect(menu()!.querySelector('.act')!.getAttribute('data-value')).toBe('m0');
    await key(input, 'ArrowDown');
    expect(menu()!.querySelector('.act')!.getAttribute('data-value')).toBe('m1');
    await key(input, 'ArrowUp');
    expect(menu()!.querySelector('.act')!.getAttribute('data-value')).toBe('m0');
    await key(input, 'ArrowUp');
    expect(menu()!.querySelector('.act')!.getAttribute('data-value')).toBe('m3');
    await key(input, 'ArrowDown');
    expect(menu()!.querySelector('.act')!.getAttribute('data-value')).toBe('m0');
    await key(input, 'Enter');
    expect(input.value).toBe('m0');
    expect(menu()).toBeNull();
  });

  it('scrolls a choices row that is outside the menu, and leaves one that is already visible', async () => {
    const scrolled = vi.fn();
    const rects = new WeakMap<Element, DOMRect>();
    const box = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return rects.get(this) ?? new DOMRect();
    });
    const hadScroll = 'scrollIntoView' in HTMLElement.prototype && typeof HTMLElement.prototype.scrollIntoView === 'function';
    if (!hadScroll) HTMLElement.prototype.scrollIntoView = () => undefined;
    const intoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
      scrolled(this);
    });
    try {
      const Box: React.FC = () => {
        const [v, setV] = useState('');
        return <Combo name="m" label="Model" value={v} onChange={setV} suggestions={[]} choices={richChoices} />;
      };
      const r = await render(<Box />);
      const input = r.container.querySelector('input[name="m"]') as HTMLInputElement;
      await act(async () => input.focus());
      const list = menu()!;
      const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
      rects.set(list, new DOMRect(0, 0, 200, 80));
      options.forEach((el, i) => rects.set(el, new DOMRect(0, i * 40, 200, 40)));
      await key(input, 'ArrowDown');
      await key(input, 'ArrowDown');
      expect(scrolled).not.toHaveBeenCalled();
      await key(input, 'ArrowDown');
      expect(scrolled).toHaveBeenCalledTimes(1);
      expect(scrolled).toHaveBeenCalledWith(options[2]);
      expect(intoView).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      box.mockRestore();
      intoView.mockRestore();
      if (!hadScroll) delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('sets the menu scroll when scrollIntoView is missing', async () => {
    const original = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: undefined });
    const rects = new WeakMap<Element, DOMRect>();
    const box = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return rects.get(this) ?? new DOMRect();
    });
    try {
      const Box: React.FC = () => {
        const [v, setV] = useState('');
        return <Combo name="m" label="Model" value={v} onChange={setV} suggestions={[]} choices={richChoices} />;
      };
      const r = await render(<Box />);
      const input = r.container.querySelector('input[name="m"]') as HTMLInputElement;
      await act(async () => input.focus());
      const list = menu()!;
      const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
      rects.set(list, new DOMRect(0, 0, 200, 80));
      options.forEach((el, i) => rects.set(el, new DOMRect(0, i * 40, 200, 40)));
      let top = 0;
      Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });
      Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 80 });
      Object.defineProperty(options[2], 'offsetTop', { configurable: true, value: 80 });
      Object.defineProperty(options[2], 'offsetHeight', { configurable: true, value: 40 });
      await key(input, 'ArrowDown');
      await key(input, 'ArrowDown');
      expect(top).toBe(0);
      await key(input, 'ArrowDown');
      expect(top).toBe(40);
    } finally {
      box.mockRestore();
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: original });
    }
  });

  it('Combo opens again on a click after Escape closed it', async () => {
    const Box: React.FC = () => {
      const [v, setV] = useState('');
      return <Combo name="m" label="Model" value={v} onChange={setV} suggestions={['sonnet', 'opus', 'haiku']} />;
    };
    const r = await render(<Box />);
    const input = r.container.querySelector('input[name="m"]') as HTMLInputElement;
    await act(async () => input.focus());
    expect(menu()).not.toBeNull();
    await key(input, 'Escape');
    expect(menu()).toBeNull();
    // Still focused, so no focus event comes: the click alone opens it.
    await click(input);
    expect(menu()).not.toBeNull();
    // A pick closes it, and a click after that opens it again too.
    await click(menu()!.querySelector('[data-value="opus"]'));
    expect(menu()).toBeNull();
    await click(input);
    expect([...menu()!.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-value'))).toEqual(['sonnet', 'opus', 'haiku']);
  });

  it('Switch says its state and flips on a click', async () => {
    const One: React.FC = () => {
      const [b, setB] = useState(true);
      return <Switch name="b" label="On" on={b} onChange={setB} />;
    };
    const r = await render(<One />);
    const b = r.container.querySelector('[name="b"]')!;
    expect([b.getAttribute('role'), b.getAttribute('aria-checked')]).toEqual(['switch', 'true']);
    await click(b);
    expect(b.getAttribute('aria-checked')).toBe('false');
  });

  it('Button is a plain button in one of the three looks', async () => {
    const r = await render(
      <>
        <Button kind="primary" className="go-x">Go</Button>
        <Button kind="secondary" small>Back</Button>
      </>,
    );
    const [a, b] = Array.from(r.container.querySelectorAll('button'));
    expect([a.getAttribute('type'), a.className]).toEqual(['button', 'btn btn-primary go-x']);
    expect(b.className).toBe('btn btn-secondary btn-sm');
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
