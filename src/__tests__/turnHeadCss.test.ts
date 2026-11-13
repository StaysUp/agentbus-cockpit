import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A turn header's grey line stays inside the card at every width: it breaks
// between its parts (jsdom lays nothing out, so this reads the stylesheet;
// the widths themselves were checked in a browser).
describe('turn header line', () => {
  it('the line can break between parts: a separator keeps its dot, a long model may break inside', () => {
    const css = readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.tb-h > span\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/);
    expect(css).toMatch(/\.tb-h > span i\.tb-agent\s*\{[^}]*white-space:\s*normal/);
    expect(css).toMatch(/\.tb-h > span i\.tb-model\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.tb-h \.sep\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).not.toMatch(/\.tb-h \.sep[^{]*\{[^}]*white-space:\s*pre/);
  });
});
