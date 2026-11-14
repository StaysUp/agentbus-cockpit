// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ConvoColumn } from '../components/ConvoColumn';
import { Markdown } from '../components/Markdown';
import { RightPanel } from '../components/RightPanel';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { click, ev, jsonl, openSession, render } from './helpers';

async function md(text: string) {
  return render(<Markdown text={text} />);
}

describe('Markdown: the agent reply in the chat', () => {
  it('renders a fenced code block with its language and a Copy button, the code as written', async () => {
    const code = 'const a = 1;\nif (a < 2 && a > 0) {\n  console.log("<b>hi</b>");\n}';
    const r = await md(`Before\n\n\`\`\`ts\n${code}\n\`\`\`\n\nAfter`);
    const block = r.container.querySelector('.md-code')!;
    expect(block.querySelector('.md-lang')!.textContent).toBe('ts');
    expect(block.querySelector('pre > code')!.textContent).toBe(code);
    expect(block.querySelector('button[aria-label="Copy"]')).not.toBeNull();
    expect(block.querySelector('b')).toBeNull();
    expect(Array.from(r.container.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['Before', 'After']);
    r.unmount();
  });

  it('a ```text block and an unclosed fence are code to their end', async () => {
    const r = await md('```text\n/Users/test/x\n**not bold**\n```\n\n~~~\nopen fence\n# not a heading');
    const codes = Array.from(r.container.querySelectorAll('pre > code')).map((c) => c.textContent);
    expect(codes).toEqual(['/Users/test/x\n**not bold**', 'open fence\n# not a heading']);
    expect(r.container.querySelector('strong, h1')).toBeNull();
    r.unmount();
  });

  it('renders inline code, and markup inside it stays text', async () => {
    const r = await md('See `/Users/test/.local/share/agentbus-mac/sessions/03e730ac3461128a` and ``a `tick` **b**``.');
    const codes = Array.from(r.container.querySelectorAll('p > code')).map((c) => c.textContent);
    expect(codes).toEqual(['/Users/test/.local/share/agentbus-mac/sessions/03e730ac3461128a', 'a `tick` **b**']);
    expect(r.container.querySelector('strong')).toBeNull();
    r.unmount();
  });

  it('renders a GitHub table with its alignment, and a row short of cells is filled', async () => {
    const r = await md('| Name | Cost | Note |\n|:-----|-----:|:----:|\n| `a` | 1 | **x** |\n| b \\| c | 2 |\n\nafter');
    const table = r.container.querySelector('.md-table > table')!;
    expect(Array.from(table.querySelectorAll('th')).map((c) => c.textContent)).toEqual(['Name', 'Cost', 'Note']);
    const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.querySelectorAll('td')).map((c) => c.textContent));
    expect(rows).toEqual([['a', '1', 'x'], ['b | c', '2', '']]);
    expect(table.querySelector('td code')!.textContent).toBe('a');
    expect(table.querySelector('td strong')!.textContent).toBe('x');
    const th = table.querySelectorAll('th') as NodeListOf<HTMLElement>;
    expect([th[0].style.textAlign, th[1].style.textAlign, th[2].style.textAlign]).toEqual(['left', 'right', 'center']);
    expect(r.container.querySelector('p')!.textContent).toBe('after');
    r.unmount();
  });

  it('a line with a pipe and no delimiter row is a paragraph', async () => {
    const r = await md('a | b\nc | d');
    expect(r.container.querySelector('table')).toBeNull();
    expect(r.container.querySelector('p')!.textContent).toBe('a | bc | d');
    r.unmount();
  });

  it('renders unordered, ordered and nested lists', async () => {
    const r = await md('Steps:\n\n1. one\n2. two\n   - inner a\n   - inner b\n3. three\n\n- x\n* y\n\n3. from three\n4. four');
    const ol = r.container.querySelectorAll(':scope > ol');
    expect(ol).toHaveLength(2);
    expect(Array.from(ol[0].querySelectorAll(':scope > li')).map((li) => li.firstChild!.textContent)).toEqual(['one', 'two', 'three']);
    expect(Array.from(ol[0].querySelectorAll('li > ul > li')).map((li) => li.textContent)).toEqual(['inner a', 'inner b']);
    expect(ol[1].getAttribute('start')).toBe('3');
    // A different bullet starts a new list.
    const ul = r.container.querySelectorAll(':scope > ul');
    expect(Array.from(ul).map((u) => u.textContent)).toEqual(['x', 'y']);
    r.unmount();
  });

  it('a year at the start of a line does not start a list inside a paragraph', async () => {
    const r = await md('It was\n2024. A good year.');
    expect(r.container.querySelector('ol')).toBeNull();
    r.unmount();
  });

  it('renders headings, a rule and a quote', async () => {
    const r = await md('# Title\n## Sub #\n###### Small\n#hashtag\n\n---\n\n> quoted **text**\n> more');
    expect(r.container.querySelector('h1')!.textContent).toBe('Title');
    expect(r.container.querySelector('h2')!.textContent).toBe('Sub');
    expect(r.container.querySelector('h6')!.textContent).toBe('Small');
    expect(r.container.querySelector('p')!.textContent).toBe('#hashtag');
    expect(r.container.querySelector('hr')).not.toBeNull();
    const q = r.container.querySelector('blockquote')!;
    expect(q.querySelector('strong')!.textContent).toBe('text');
    expect(q.textContent).toBe('quoted textmore');
    r.unmount();
  });

  it('renders bold, italics and strikethrough; snake_case and lone stars stay text', async () => {
    const r = await md('**bold** and __also__, *it* and _it2_, ***both***, ~~gone~~, my_var_name, 2 * 3 * 4');
    const p = r.container.querySelector('p')!;
    expect(Array.from(p.querySelectorAll(':scope > strong')).map((e) => e.textContent)).toEqual(['bold', 'also', 'both']);
    expect(Array.from(p.querySelectorAll(':scope > em')).map((e) => e.textContent)).toEqual(['it', 'it2']);
    expect(p.querySelector('strong > em')!.textContent).toBe('both');
    expect(p.querySelector('del')!.textContent).toBe('gone');
    expect(p.textContent).toContain('my_var_name, 2 * 3 * 4');
    r.unmount();
  });

  it('a web link opens in a new tab with noreferrer noopener', async () => {
    const r = await md('Read [the **docs**](https://example.com/a_(b) "t"), <http://x.org/y> or https://e.com/p?q=1.');
    const links = Array.from(r.container.querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a_(b)', 'http://x.org/y', 'https://e.com/p?q=1']);
    expect(links.map((a) => a.textContent)).toEqual(['the docs', 'http://x.org/y', 'https://e.com/p?q=1']);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noreferrer noopener');
    }
    expect(r.container.querySelector('p')!.textContent!.endsWith('https://e.com/p?q=1.')).toBe(true);
    r.unmount();
  });

  it('a javascript:, data: or mailto: link is not a link, and shows as written', async () => {
    const src = '[a](javascript:alert(1)) [b](JavaScript:alert(2)) [c](data:text/html,x) [m](mailto:x@e.com) <javascript:x>';
    const r = await md(src);
    expect(r.container.querySelector('a')).toBeNull();
    expect(r.container.textContent).toBe(src);
    r.unmount();
  });

  it('a link to a local file is a file reference, never a browser link: its words, the path from the session folder with its line, the full path on hover', async () => {
    const full = '/Users/test/.local/share/agentbus-mac/sessions/14b92fbf510e8dce/cmd/agentbus/main.go:69';
    const r = await render(
      <Markdown
        text={`See [current CLI source](${full}) and [a.ts](/home/me/proj/src/a.ts#L12) and [./file](./file) and [x](file:///tmp/x%20y.txt).`}
        files={{ session: '14b92fbf510e8dce', folder: '/home/me/proj/' }}
      />,
    );
    expect(r.container.querySelector('a')).toBeNull();
    const refs = Array.from(r.container.querySelectorAll('.md-file'));
    expect(refs.map((f) => f.textContent)).toEqual([
      'current CLI source cmd/agentbus/main.go:69',
      'a.ts src/a.ts:12',
      './file',
      'x /tmp/x y.txt',
    ]);
    expect(refs.map((f) => f.getAttribute('title'))).toEqual([full, '/home/me/proj/src/a.ts:12', './file', '/tmp/x y.txt']);
    expect(refs[0].querySelector('.md-file-path')!.textContent).toBe('cmd/agentbus/main.go:69');
    r.unmount();
  });

  it('a file link outside the session folder keeps its whole path; without a session the path shows as written', async () => {
    const r = await md('[other](/Users/test/.local/share/agentbus-mac/sessions/aaaaaaaaaaaaaaaa/x.go) [main.go:3](main.go:3)');
    const refs = Array.from(r.container.querySelectorAll('.md-file'));
    expect(refs.map((f) => f.textContent)).toEqual(['other /Users/test/.local/share/agentbus-mac/sessions/aaaaaaaaaaaaaaaa/x.go', 'main.go:3']);
    expect(r.container.querySelector('a')).toBeNull();
    r.unmount();
  });

  it('a link inside a link text is not nested', async () => {
    const r = await md('[https://a.com](https://b.com)');
    const links = r.container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://b.com/');
    r.unmount();
  });

  it('a <script> or other HTML tag shows as text and is never made an element', async () => {
    const src = '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n<b>bold?</b> &amp;';
    const r = await md(src);
    expect(r.container.querySelector('script, img, b')).toBeNull();
    expect(r.container.textContent).toBe(src.replace(/\n/g, ''));
    // Inside a table cell and a heading too.
    const r2 = await md('# <i>x</i>\n\n| <script>y</script> |\n| - |\n| <img src=z> |');
    expect(r2.container.querySelector('script, img, i')).toBeNull();
    expect(r2.container.querySelector('h1')!.textContent).toBe('<i>x</i>');
    expect(r2.container.querySelector('th')!.textContent).toBe('<script>y</script>');
    r.unmount();
    r2.unmount();
  });

  it('a fence keeps its tabs, in what it shows and what Copy writes, and a fence may start with a tab', async () => {
    const r = await md('```makefile\nall:\n\tgo test ./...\n```\n\n\t```go\n\tfunc f() {\n\t\treturn\n\t}\n\t```\n\n- item\n\n  ```\n  \tx\n  ```');
    const codes = Array.from(r.container.querySelectorAll('pre > code')).map((c) => c.textContent);
    expect(codes).toEqual(['all:\n\tgo test ./...', 'func f() {\n\treturn\n}', '\tx']);
    expect(r.container.querySelectorAll('.md-lang')[1].textContent).toBe('go');
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t: string) => { copied = t; } }, configurable: true });
    await click(r.container.querySelector('.md-code button[aria-label="Copy"]'));
    expect(copied).toBe('all:\n\tgo test ./...');
    r.unmount();
  });

  it('a cut preview ends in a mark that is never part of a link or a fence', async () => {
    const r = await render(<Markdown text={'See https://example.com/foo'} cut />);
    expect(r.container.querySelector('a')!.getAttribute('href')).toBe('https://example.com/foo');
    expect(r.container.querySelector('p')!.textContent).toBe('See https://example.com/foo…');
    const r2 = await render(<Markdown text={'```\ncode\n```'} cut />);
    expect(r2.container.querySelector('pre > code')!.textContent).toBe('code');
    expect(r2.container.querySelector('.md-cut')!.textContent).toBe('…');
    const r3 = await render(<Markdown text={'- a\n- b'} cut />);
    expect(Array.from(r3.container.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['a', 'b…']);
    r.unmount();
    r2.unmount();
    r3.unmount();
  });

  it('a bare url leaves out a "]" or ")" it did not open, and a trailing ellipsis', async () => {
    const r = await md('[https://example.com/docs] (see https://e.com/a_(b)) https://x.org/y…');
    expect(Array.from(r.container.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com/docs',
      'https://e.com/a_(b)',
      'https://x.org/y',
    ]);
    expect(r.container.textContent).toBe('[https://example.com/docs] (see https://e.com/a_(b)) https://x.org/y…');
    r.unmount();
  });

  it('a single newline is a line break, a blank line a new paragraph, and escapes keep marks', async () => {
    const r = await md('one\ntwo\n\nthree \\*not\\* em');
    const ps = r.container.querySelectorAll('p');
    expect(ps).toHaveLength(2);
    expect(ps[0].querySelectorAll('br')).toHaveLength(1);
    expect(ps[0].textContent).toBe('onetwo');
    expect(ps[1].textContent).toBe('three *not* em');
    expect(r.container.querySelector('em')).toBeNull();
    r.unmount();
  });
});

describe('Markdown in the chat and raw in the turn panel', () => {
  const reply = '**Done.** Files:\n\n```text\n/Users/test/a.txt\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  async function session() {
    const src = new ReplayDataSource(
      jsonl([
        ev({ kind: 'turn.started', session: 'm1', turn: 'T1', exchange: 'x1', text: 'list **files** `x`' }),
        ev({ kind: 'model.requested', session: 'm1', turn: 'T1', exchange: 'x1', model: 'm' }),
        ev({ kind: 'model.responded', session: 'm1', turn: 'T1', exchange: 'x1', status: 200, text: reply }),
      ]),
    );
    return (await openSession(src, 'm1'))!;
  }

  it('the chat formats the agent reply and leaves the person message as typed', async () => {
    const s = await session();
    const r = await render(<ConvoColumn session={s} selectedTurn={null} onSelectTurn={() => {}} />);
    const agent = r.container.querySelector('#convo .m-agent')!;
    expect(agent.querySelector('strong')!.textContent).toBe('Done.');
    expect(agent.querySelector('pre > code')!.textContent).toBe('/Users/test/a.txt');
    expect(agent.querySelector('table')).not.toBeNull();
    const bubble = r.container.querySelector('#convo .m-user .bubble')!;
    expect(bubble.textContent).toBe('list **files** `x`');
    expect(bubble.querySelector('strong, code')).toBeNull();
    r.unmount();
  });

  it('the turn panel shows the recorded reply raw', async () => {
    const s = await session();
    const turn = s.turnsList[0];
    const r = await render(<RightPanel turn={turn} totalTurns={1} selection={null} onSelectEvent={() => {}} />);
    const body = r.container.querySelector('#d-body')!;
    expect(body.querySelector('strong, pre, table, .md-code')).toBeNull();
    expect(body.querySelector('.reply')!.textContent).toBe(reply.replace(/\n\n/g, ''));
    expect(body.textContent).toContain('**Done.**');
    expect(body.textContent).toContain('```text');
    r.unmount();
  });
});
