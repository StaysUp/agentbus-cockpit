import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The message box's layout, read from the stylesheet (jsdom lays nothing
// out). The browser check at 390, 768 and 1440px is by eye.
describe('the message box styles', () => {
  const css = readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel: string) => {
    const m = css.match(new RegExp(`(^|\\n)${sel.replace(/[.#*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
    expect(m, sel).not.toBeNull();
    return m![2];
  };

  it('wraps the controls under the text when they do not fit beside it', () => {
    expect(rule('#c-reply .box')).toMatch(/display:\s*flex/);
    expect(rule('#c-reply .box')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('#c-reply #input')).toMatch(/min-width:\s*0/);
  });

  it('grows to about ten lines, then scrolls inside', () => {
    expect(rule('#c-reply #input')).toMatch(/max-height:\s*calc\(1\.35em \* 10/);
    expect(rule('#c-reply #input')).toMatch(/overflow-y:\s*auto/);
  });

  it('places nothing over the text: no control is positioned absolutely', () => {
    for (const sel of ['#c-reply .go', '#c-reply .next-agent', '#c-reply .next-agent-at', '#c-reply .go-split']) {
      expect(rule(sel)).not.toMatch(/position:\s*absolute/);
    }
    expect(css).not.toMatch(/#c-reply[^{]*\{[^}]*position:\s*absolute/);
  });

  it('gives Send and Stop a fixed least width, so a changing label moves nothing', () => {
    expect(rule('#c-reply .go-split .go')).toMatch(/min-width:\s*4\.5rem/);
    expect(rule('#c-reply .go.stop')).toMatch(/min-width:\s*6rem/);
  });
});
