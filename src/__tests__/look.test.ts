import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The cockpit's look is defined once: one selected and hover style for every
// list, one for every table, one set of buttons, one yes/no control. These
// read the sources and fail on the regressions that came back most often: a
// list with its own selected colour, a button with its own one-off style, a
// list row that left out the shared class, a yes/no drawn as a select.

// Read from disk: the test runner gives a stylesheet no text of its own.
const css = ['base.css', 'app.css', 'markdown.css', 'narrow.css'].map((f) => readFileSync(new URL(`../styles/${f}`, import.meta.url), 'utf8')).join('\n');
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
    const oneOff = /\.(connect-go|rn-btn|cs-btn|cs-open|rb-go|rb-fix|head-btn|pg-save|new-session|add-agent|ag-(edit|remove|yes|keep))\b/;
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
    // "Turn 1 of 2" first, then the prompt, which is the part that is cut.
    expect(tsx['../components/RightPanel.tsx']).toMatch(/<span className="ph-n">[\s\S]*?<\/span>\s*<span className="ch-sub ph-t">/);
  });
});

describe('the rename pencil', () => {
  it('shows on hover of its card or header and on keyboard focus, quiet, the same in both', () => {
    // His call, 2026-11-17: clicking the name renames, so the pencil stays out
    // of sight until its card or the header is hovered, or it has keyboard focus.
    const all = rules(css);
    const base = all.filter(([sel]) => sel === '.s-rename, .c-rename').map(([, body]) => body).join(';');
    expect(base).toMatch(/opacity:\s*0\b/);
    expect(base).toMatch(/color:\s*var\(--ink3\)/);
    const shown = all.find(([sel, body]) => sel.includes('.sess-row:hover .s-rename') && /opacity:\s*1\b/.test(body))?.[0] ?? '';
    for (const sel of ['.sess-row:hover .s-rename', '#c-head:hover .c-rename', '.s-rename:focus-visible', '.c-rename:focus-visible']) {
      expect(shown).toContain(sel);
    }
    // Still in the page, so it can be reached by keyboard: never removed.
    const removed = all.filter(([sel, body]) => /\.(s|c)-rename\b/.test(sel) && /visibility:\s*hidden|display:\s*none/.test(body));
    expect(removed).toEqual([]);
  });
});

describe('one button', () => {
  it('defines .btn once, and no dialog builds its own shell', () => {
    expect(rules(css).filter(([sel]) => sel === '.btn')).toHaveLength(1);
    // Every dialog is Dialog.tsx: no other file draws a modal back or an Esc listener of its own.
    const own = Object.entries(tsx)
      .filter(([f, src]) => !f.endsWith('/Dialog.tsx') && /className="modal-back"/.test(src))
      .map(([f]) => f);
    expect(own).toEqual([]);
  });

  it('shows no placeholder for what does not work yet', () => {
    const found = Object.entries(tsx)
      .filter(([, src]) => /coming soon|Coming next|Not available yet/i.test(src))
      .map(([f]) => f);
    expect(found).toEqual([]);
  });
});

describe('an opened table row', () => {
  it('fills its row and never widens the table: its detail scrolls inside', () => {
    const all = rules(css);
    expect(all.find(([sel]) => sel === '.ev-in')?.[1]).toMatch(/width:\s*0;\s*min-width:\s*100%/);
    expect(all.find(([sel]) => sel === '.ev-in .term')?.[1]).toMatch(/overflow:\s*auto/);
    // Events and Model calls both wrap their opened detail.
    expect(tsx['../components/RightPanel.tsx'].match(/className="ev-in"/g)).toHaveLength(2);
  });
});

describe('the apply panel', () => {
  it('keeps its bar at the foot, outside the scroll, so no file row shows below it', () => {
    const all = rules(css);
    const bar = all.find(([sel]) => sel === '.apply-panel .ap-actions')?.[1] ?? '';
    expect(bar).toMatch(/flex:\s*none/);
    expect(bar).not.toMatch(/sticky/);
    // #d-body is the one area that scrolls, as in every other panel.
    expect(all.find(([sel]) => sel === '#d-body')?.[1]).toMatch(/overflow-y:\s*auto/);
  });
});
