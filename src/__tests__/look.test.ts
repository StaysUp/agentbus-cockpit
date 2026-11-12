import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The cockpit's look is defined once: one selected and hover style for every
// list, one for every table, one set of buttons, one yes/no control. These
// read the sources and fail on the regressions that came back most often: a
// list with its own selected colour, a button with its own one-off style, a
// list row that left out the shared class, a yes/no drawn as a select.

// Read from disk: the test runner gives a stylesheet no text of its own.
const css = ['base.css', 'app.css'].map((f) => readFileSync(new URL(`../styles/${f}`, import.meta.url), 'utf8')).join('\n');
const tsx = import.meta.glob(['../components/*.tsx', '../*.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

// rules is every CSS rule as [selector, body], comments and at-rule heads left out.
function rules(src: string): [string, string][] {
  const plain = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: [string, string][] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(plain); m; m = re.exec(plain)) out.push([m[1].trim().replace(/^@[^{]*$/, ''), m[2]]);
  return out;
}

describe('one look', () => {
  const all = rules(css);

  it('a picked row looks the same in every list and every table', () => {
    // A picked state that paints a background or a shadow: only the shared
    // rules, and the controls whose "on" is their own state (a Seg's chosen
    // option, a switch, a tab's underline).
    const own = /\.nd-seg\b|\.sw\.on|\.tab\.on|\.strip i\.on/;
    const painted = all
      .filter(([sel, body]) => /\.(on|sel|lvl-sel)\b|aria-(current|selected)/.test(sel) && /\b(background|box-shadow)\s*:/.test(body))
      .map(([sel]) => sel)
      .filter((sel) => !own.test(sel));
    expect(painted).toEqual([
      '.pick.on, .pick.sel, .pick.on:hover, .pick.sel:hover',
      '.grid tr.sel td, .grid tr.sel:hover td',
    ]);
    expect(css).not.toMatch(/--sel-row|--sel-bar/);
  });

  it('every list row takes the shared class', () => {
    // A queued turn is not a row to pick: it opens nothing.
    const rows = /className=\{?[`"]((?:prow|sess|side-chat|tb)(?=[\s`"$])[^`"]*)[`"]/g;
    const missing: string[] = [];
    for (const [f, src] of Object.entries(tsx)) {
      for (let m = rows.exec(src); m; m = rows.exec(src)) if (!/\bpick\b/.test(m[1]) && !m[1].startsWith('tb pending')) missing.push(`${f}: ${m[1]}`);
    }
    expect(missing).toEqual([]);
  });

  it('no button has a look of its own', () => {
    const oneOff = /\.(connect-go|use-recorded|rn-btn|cs-btn|cs-open|rb-go|rb-fix|head-btn|page-back|pg-save|new-session|add-agent|ag-(edit|remove|yes|keep))\b/;
    const styled = all
      .filter(([sel, body]) => oneOff.test(sel) && /\b(background|border|color)\s*:/.test(body))
      .map(([sel]) => sel);
    expect(styled).toEqual([]);
  });

  it('a yes or a no is a Switch, never a select, a checkbox or a two-way Seg', () => {
    const yesNo = /options=\{\[\s*\{\s*value:\s*["'](off|on|yes|no|true|false)["'][^}]*\},\s*\{\s*value:\s*["'](off|on|yes|no|true|false)["'][^}]*\},?\s*\]\}/;
    const found = Object.entries(tsx)
      .filter(([, src]) => yesNo.test(src) || /role="checkbox"|<Checkbox\b/.test(src))
      .map(([f]) => f);
    expect(found).toEqual([]);
  });
});

describe('one type scale', () => {
  it('small text takes one of the three steps, never a size of its own', () => {
    // Every font size under 0.875rem is var(--fs-xs), var(--fs-s) or
    // var(--fs-m); the steps themselves are set once, on :root.
    const sizes = rules(css)
      .filter(([sel]) => sel !== ':root')
      .flatMap(([sel, body]) => [...body.matchAll(/font-size:\s*([^;]+)/g)].map((m) => [sel, m[1].trim()] as [string, string]));
    const small = sizes.filter(([, v]) => {
      if (/max\(/.test(v)) return true;
      const rem = /^([0-9.]+)rem$/.exec(v);
      return !!rem && Number(rem[1]) < 0.875;
    });
    expect(small).toEqual([]);
    const steps = new Set(sizes.map(([, v]) => v).filter((v) => v.startsWith('var(')));
    expect([...steps].sort()).toEqual(['var(--fs-m)', 'var(--fs-s)', 'var(--fs-xs)']);
  });
});

describe('the turn header', () => {
  it('cuts a long title, never "turn 1 of 2"', () => {
    const all = rules(css);
    const body = (sel: string) => all.find(([s]) => s === sel)?.[1] ?? '';
    expect(body('#p-head .colhead-title')).toMatch(/display:\s*flex/);
    expect(body('#p-head .colhead-title > *')).toMatch(/flex:\s*none/);
    expect(body('#p-head .colhead-title > .ph-t')).toMatch(/min-width:\s*0.*text-overflow:\s*ellipsis/);
    expect(tsx['../components/RightPanel.tsx']).toMatch(/<span className="ph-t">[\s\S]*?<\/span>\s*<span className="ch-sub">/);
  });
});
