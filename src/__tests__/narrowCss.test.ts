import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The cockpit's layout at each width, read from the stylesheet (jsdom
// applies no media queries): each width has its rule. The column switching
// itself is in narrow.test.tsx.
describe('narrow.css', () => {
  const css = readFileSync(new URL('../styles/narrow.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (head: string) => {
    const at = css.indexOf(head);
    expect(at).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i++) {
      if (css[i] === '{') depth++;
      if (css[i] === '}' && --depth === 0) return css.slice(at, i);
    }
    return '';
  };

  it('900-1200px: the open panel is an overlay from the right, over a full-width conversation', () => {
    const mid = block('@media (min-width: 901px) and (max-width: 1200px)');
    expect(mid).toMatch(/#app\.panel #right\s*\{[^}]*position:\s*absolute[^}]*right:\s*0/);
    expect(mid).toMatch(/#app\.panel #convo\s*\{[^}]*flex:\s*1/);
  });

  it('under 900px: one column per data-column, Agents hidden until its menu opens', () => {
    const narrow = block('@media (max-width: 900px)');
    for (const [col, sel] of [['sessions', '> #sessions'], ['convo', '> #convo'], ['turn', '#right']]) {
      expect(narrow).toContain(`#app[data-column="${col}"] ${sel}`);
    }
    expect(narrow).toMatch(/#app > #agents\s*\{\s*display:\s*none/);
    expect(narrow).toMatch(/#app\.agents-open > #agents\s*\{[^}]*display:\s*flex/);
    expect(narrow).toMatch(/min-height:\s*40px/);
  });

  it('no rule above 1200px', () => {
    expect(css).not.toMatch(/min-width:\s*(1[2-9]\d\d|[2-9]\d\d\d)px/);
  });
});
