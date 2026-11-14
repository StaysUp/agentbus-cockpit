import React, { createContext, useContext } from 'react';
import { CopyButton } from './Icons';

// A small markdown renderer for an agent's reply in the chat. It reads the
// common subset agents write: fenced code, inline code, GitHub tables, lists,
// headings, block quotes, rules, bold, italics, strikethrough, links,
// paragraphs and line breaks. It builds React elements only, so the agent's
// text is never read as HTML: a tag it writes shows as text. Anything it does
// not understand stays plain text.

type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; level: number; text: string }
  | { t: 'code'; lang: string; code: string }
  | { t: 'hr' }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][]; tight: boolean }
  | { t: 'table'; align: Align[]; head: string[]; rows: string[][] };

type Align = 'left' | 'center' | 'right' | undefined;

const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+(.*))?$/;
const DELIM = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;

const blank = (s: string) => s.trim() === '';

// A line's indent in columns; a tab moves to the next multiple of four.
function indentOf(s: string): number {
  let col = 0;
  for (const c of s) {
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// The line with up to `n` columns of indent taken off. Tabs after that point,
// in code especially, stay as written.
function dropIndent(s: string, n: number): string {
  let col = 0;
  let i = 0;
  while (i < s.length && col < n) {
    if (s[i] === ' ') col++;
    else if (s[i] === '\t') {
      const next = col + 4 - (col % 4);
      if (next > n) return ' '.repeat(next - n) + s.slice(i + 1);
      col = next;
    } else break;
    i++;
  }
  return s.slice(i);
}

// Splits one table row into its cells. A backslash keeps a pipe in its cell.
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      out.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

function tableStarts(lines: string[], i: number): boolean {
  const head = lines[i];
  const delim = lines[i + 1];
  if (delim === undefined || !head.includes('|') || !delim.includes('|') || !DELIM.test(delim)) return false;
  return cells(head).length === cells(delim).length;
}

// True when the line begins a list item that may end a paragraph: one with
// text, and when numbered, numbered 1 (so "2024. was a year" stays text).
function itemInterrupts(l: string): boolean {
  const m = l.match(ITEM);
  return !!m && !blank(m[4] ?? '') && (!/\d/.test(m[2]) || parseInt(m[2], 10) === 1);
}

// True when the line begins a block other than a paragraph, so it ends one.
function interrupts(lines: string[], i: number): boolean {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || itemInterrupts(l) || tableStarts(lines, i);
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const [, pad, mark, lang] = fence;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        const close = l.trim();
        if (close.length >= mark.length && close === mark[0].repeat(close.length)) {
          i++;
          break;
        }
        // The fence's own indent comes off each line, as far as it goes.
        body.push(dropIndent(l, indentOf(pad)));
        i++;
      }
      out.push({ t: 'code', lang, code: body.join('\n') });
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      out.push({ t: 'h', level: h[1].length, text: h[2] ?? '' });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !blank(lines[i])) {
        const q = lines[i].match(QUOTE);
        // A line without '>' continues the quote's paragraph.
        body.push(q ? q[1] : lines[i]);
        i++;
      }
      out.push({ t: 'quote', blocks: parseBlocks(body.join('\n')) });
      continue;
    }

    if (ITEM.test(line)) {
      const first = line.match(ITEM)!;
      const ordered = /\d/.test(first[2]);
      const kind = (m: RegExpMatchArray) => (/\d/.test(m[2]) ? m[2].slice(-1) : m[2]);
      const items: Block[][] = [];
      let tight = true;
      while (i < lines.length) {
        const m = lines[i].match(ITEM);
        if (!m || kind(m) !== kind(first)) break;
        // The item's content starts where its text starts; later lines indented
        // that far (or a lazy line right after text) belong to it.
        const content = m[3] ? m[1].length + m[2].length + (m[3].length - (m[4] ?? '').length) : m[1].length + m[2].length + 1;
        const body: string[] = [m[4] ?? ''];
        i++;
        let sawBlank = false;
        while (i < lines.length) {
          const l = lines[i];
          if (blank(l)) {
            sawBlank = true;
            body.push('');
            i++;
            continue;
          }
          if (indentOf(l) >= content) {
            if (sawBlank) tight = false;
            sawBlank = false;
            body.push(dropIndent(l, content));
            i++;
            continue;
          }
          if (!sawBlank && !ITEM.test(l) && !interrupts(lines, i)) {
            body.push(l.trim());
            i++;
            continue;
          }
          break;
        }
        while (body.length > 0 && blank(body[body.length - 1])) body.pop();
        items.push(parseBlocks(body.join('\n')));
        // A blank line between two items makes the list loose.
        if (sawBlank && i < lines.length && lines[i].match(ITEM) && kind(lines[i].match(ITEM)!) === kind(first)) tight = false;
      }
      out.push({ t: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items, tight });
      continue;
    }

    if (tableStarts(lines, i)) {
      const head = cells(line);
      const align: Align[] = cells(lines[i + 1]).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : undefined;
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) {
        const row = cells(lines[i]).slice(0, head.length);
        while (row.length < head.length) row.push('');
        rows.push(row);
        i++;
      }
      out.push({ t: 'table', align, head, rows });
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i]) && !interrupts(lines, i)) {
      para.push(lines[i].trim());
      i++;
    }
    out.push({ t: 'p', text: para.join('\n') });
  }
  return out;
}

// Only web links become links. A local path becomes a file reference
// (FileLink); anything else (javascript:, data:) stays as the text the agent
// wrote.
export function safeHref(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const WORD = /[\p{L}\p{N}]/u;

// The end of a backtick run of the same length starting after `from`, or -1.
function closeTicks(s: string, from: number, n: number): number {
  let j = from;
  while (j < s.length) {
    const k = s.indexOf('`', j);
    if (k < 0) return -1;
    let e = k;
    while (s[e] === '`') e++;
    if (e - k === n) return k;
    j = e;
  }
  return -1;
}

// Where `delim` closes emphasis that opened before `from`, skipping escapes
// and code spans; -1 when it never does.
function closeDelim(s: string, from: number, delim: string): number {
  let j = from;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') {
      let e = j;
      while (s[e] === '`') e++;
      const k = closeTicks(s, e, e - j);
      j = k < 0 ? e : k + (e - j);
      continue;
    }
    if (s.startsWith(delim, j) && j > from && !/\s/.test(s[j - 1])) {
      const after = s[j + delim.length];
      // A single * or _ must not be part of a longer run (that is bold).
      if (delim.length === 1 && after === delim) {
        j += 2;
        continue;
      }
      // In a run of three, "**" closes at its last two marks.
      if (delim.length === 2 && after === delim[0]) {
        j++;
        continue;
      }
      if (delim[0] === '_' && after !== undefined && WORD.test(after)) {
        j++;
        continue;
      }
      return j;
    }
    j++;
  }
  return -1;
}

// The end of a link's destination "(url)" or "(url "title")" opening at `open`,
// with its url; parentheses inside the url must balance.
function linkDest(s: string, open: number): { url: string; end: number } | undefined {
  let j = open + 1;
  while (s[j] === ' ') j++;
  let url = '';
  let depth = 0;
  if (s[j] === '<') {
    const k = s.indexOf('>', j);
    if (k < 0) return undefined;
    url = s.slice(j + 1, k);
    j = k + 1;
  } else {
    while (j < s.length && !/\s/.test(s[j])) {
      if (s[j] === '(') depth++;
      if (s[j] === ')') {
        if (depth === 0) break;
        depth--;
      }
      url += s[j];
      j++;
    }
  }
  while (s[j] === ' ') j++;
  if (s[j] === '"' || s[j] === "'") {
    const k = s.indexOf(s[j], j + 1);
    if (k < 0) return undefined;
    j = k + 1;
    while (s[j] === ' ') j++;
  }
  return s[j] === ')' ? { url, end: j + 1 } : undefined;
}

// The "]" that closes a link's text opening at `open`, or -1.
function closeBracket(s: string, open: number): number {
  let depth = 0;
  for (let j = open + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '[') depth++;
    else if (s[j] === ']') {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
}

const BARE_URL = /^https?:\/\/[^\s<>]+/i;

// A bare url stops before trailing punctuation, an ellipsis, and a ")" or "]"
// it did not open.
function trimUrl(u: string): string {
  const count = (s: string, c: string) => s.split(c).length - 1;
  let url = u;
  for (;;) {
    const before = url;
    url = url.replace(/[.,;:!?'"*_~\u2026]+$/u, '');
    if (url.endsWith(')') && count(url, '(') < count(url, ')')) url = url.slice(0, -1);
    if (url.endsWith(']') && count(url, '[') < count(url, ']')) url = url.slice(0, -1);
    if (url === before) return url;
  }
}

// Where a reply's local paths are read from: the session (its copy is
// <runner data>/sessions/<session id>, or worktrees/<id> before 0.5) and the
// person's folder. A path inside either is shown relative to it.
export interface FileBase {
  session?: string;
  folder?: string;
}
const FileBaseContext = createContext<FileBase>({});

// A link's destination that names a local file: a file: URL, or a path with
// no scheme ("/Users/…/main.go:69", "src/a.ts"). A ":69" after a name is a
// line, not a scheme. Anything else (javascript:, mailto:, "#…") is not.
export function localPath(url: string): string | undefined {
  if (url === '' || url.startsWith('#') || url.startsWith('//')) return undefined;
  let p = url;
  if (/^file:/i.test(url)) {
    p = url.replace(/^file:(\/\/[^/]*)?/i, '');
  } else if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(url)) {
    return undefined;
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    // Not percent-encoded as it should be: keep it as written.
  }
  return p || undefined;
}

// A local path as the chat shows it: relative to the session's copy or the
// person's folder when inside one, with its line (":69", or "#L69" as
// ":69"), and the full path for hover.
export function fileRef(path: string, base: FileBase): { rel: string; full: string } {
  const m = path.match(/^(.*?)(?:#L(\d+)(?:-L?\d+)?)?$/);
  const full = m && m[2] ? `${m[1]}:${m[2]}` : path;
  let rel = full;
  const copy = base.session ? full.match(new RegExp(`/(?:sessions|worktrees)/${base.session.replace(/[^\w-]/g, '')}/(.+)$`)) : null;
  const folder = base.folder?.replace(/\/+$/, '');
  if (copy) rel = copy[1];
  else if (folder && full.startsWith(`${folder}/`)) rel = full.slice(folder.length + 1);
  return { rel, full };
}

// A link to a local file: its words, then its path, quietly. It is not a
// browser link; the full path shows on hover.
function FileLink({ path, label, children }: { path: string; label: string; children: React.ReactNode }) {
  const { rel, full } = fileRef(path, useContext(FileBaseContext));
  const said = label.trim();
  const noPath = said === rel || said === full || said === '';
  return (
    <span className="md-file" title={full}>
      {noPath ? <code>{rel}</code> : children}
      {!noPath && (
        <>
          {' '}
          <code className="md-file-path">{rel}</code>
        </>
      )}
    </span>
  );
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  // A link opens in a new tab and does not also select the turn under it.
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
      {children}
    </a>
  );
}

// `links` is false inside a link's own text, so links never nest.
function inline(s: string, key = 'i', links = true): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let text = '';
  let n = 0;
  const k = () => `${key}.${n++}`;
  const flush = () => {
    if (!text) return;
    // A single newline inside a paragraph is a line break.
    text.split('\n').forEach((part, i) => {
      if (i > 0) out.push(<br key={k()} />);
      if (part) out.push(part);
    });
    text = '';
  };
  const push = (node: React.ReactNode) => {
    flush();
    out.push(node);
  };

  let i = 0;
  while (i < s.length) {
    const c = s[i];

    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) {
      text += s[i + 1];
      i += 2;
      continue;
    }

    if (c === '`') {
      let e = i;
      while (s[e] === '`') e++;
      const close = closeTicks(s, e, e - i);
      if (close < 0) {
        text += s.slice(i, e);
        i = e;
        continue;
      }
      let code = s.slice(e, close).replace(/\n/g, ' ');
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1);
      push(<code key={k()}>{code}</code>);
      i = close + (e - i);
      continue;
    }

    if (c === '[' && links) {
      const close = closeBracket(s, i);
      if (close > 0 && s[close + 1] === '(') {
        const dest = linkDest(s, close + 1);
        if (dest) {
          const href = safeHref(dest.url);
          if (href) {
            push(
              <Link key={k()} href={href}>
                {inline(s.slice(i + 1, close), k(), false)}
              </Link>,
            );
          } else if (localPath(dest.url)) {
            const label = s.slice(i + 1, close);
            push(
              <FileLink key={k()} path={localPath(dest.url)!} label={label}>
                {inline(label, k(), false)}
              </FileLink>,
            );
          } else {
            // Neither a web link nor a local file: the whole thing stays as written.
            text += s.slice(i, dest.end);
          }
          i = dest.end;
          continue;
        }
      }
    }

    if (c === '<' && links) {
      const m = s.slice(i).match(/^<(https?:\/\/[^\s<>]+)>/);
      const href = m ? safeHref(m[1]) : undefined;
      if (m && href) {
        push(
          <Link key={k()} href={href}>
            {m[1]}
          </Link>,
        );
        i += m[0].length;
        continue;
      }
    }

    if ((c === 'h' || c === 'H') && links && (i === 0 || !WORD.test(s[i - 1]))) {
      const m = s.slice(i).match(BARE_URL);
      if (m) {
        const url = trimUrl(m[0]);
        const href = safeHref(url);
        if (href && url.length > 'https://'.length) {
          push(
            <Link key={k()} href={href}>
              {url}
            </Link>,
          );
          i += url.length;
          continue;
        }
      }
    }

    if (c === '*' || c === '_' || c === '~') {
      const two = s[i + 1] === c;
      const delim = two ? c + c : c;
      const after = s[i + delim.length];
      const before = i > 0 ? s[i - 1] : undefined;
      // An opening mark is followed by text, and an underscore inside a word
      // (snake_case) is not a mark.
      const opens = after !== undefined && !/\s/.test(after) && !(c === '_' && before !== undefined && WORD.test(before)) && (c !== '~' || two);
      if (opens) {
        const close = closeDelim(s, i + delim.length, delim);
        if (close > i + delim.length) {
          const inner = inline(s.slice(i + delim.length, close), k(), links);
          if (c === '~') push(<del key={k()}>{inner}</del>);
          else if (two) push(<strong key={k()}>{inner}</strong>);
          else push(<em key={k()}>{inner}</em>);
          i = close + delim.length;
          continue;
        }
      }
      text += delim;
      i += delim.length;
      continue;
    }

    text += c;
    i++;
  }
  flush();
  return out;
}

// `tail` goes at the end of the last block: the mark that says a preview was
// cut. It is added after parsing, so it never becomes part of a link or code.
function renderBlocks(blocks: Block[], key: string, tight = false, tail?: React.ReactNode): React.ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${key}.${i}`;
    const end = i === blocks.length - 1 ? tail : undefined;
    const after = (node: React.ReactNode) =>
      end ? (
        <React.Fragment key={k}>
          {node}
          <p className="md-cut">{end}</p>
        </React.Fragment>
      ) : (
        node
      );
    switch (b.t) {
      case 'p':
        return tight ? (
          <React.Fragment key={k}>
            {inline(b.text, k)}
            {end}
          </React.Fragment>
        ) : (
          <p key={k}>
            {inline(b.text, k)}
            {end}
          </p>
        );
      case 'h': {
        const Tag = `h${b.level}` as 'h1';
        return (
          <Tag key={k} className={`md-h md-h${b.level}`}>
            {inline(b.text, k)}
            {end}
          </Tag>
        );
      }
      case 'code':
        return after(
          <div key={k} className="md-code">
            <div className="md-code-h">
              <span className="md-lang">{b.lang}</span>
              <CopyButton text={b.code} />
            </div>
            <pre>
              <code>{b.code}</code>
            </pre>
          </div>,
        );
      case 'hr':
        return after(<hr key={k} />);
      case 'quote':
        return <blockquote key={k}>{renderBlocks(b.blocks, k, false, end)}</blockquote>;
      case 'list': {
        const items = b.items.map((item, j) => (
          <li key={j}>{renderBlocks(item, `${k}.${j}`, b.tight, j === b.items.length - 1 ? end : undefined)}</li>
        ));
        return b.ordered ? (
          <ol key={k} start={b.start === 1 ? undefined : b.start}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        );
      }
      case 'table':
        return after(
          <div key={k} className="md-table">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>
                      {inline(c, `${k}.h${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((c, j) => (
                      <td key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>
                        {inline(c, `${k}.${r}.${j}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
    }
  });
}

// `cut` says the text is a preview cut short: a "…" follows its last block.
// `files` is where local paths in links are shown relative to.
export function Markdown({ text, cut = false, files }: { text: string; cut?: boolean; files?: FileBase }) {
  const blocks = parseBlocks(text);
  if (cut && blocks.length === 0) return <p className="md-cut">…</p>;
  const out = <>{renderBlocks(blocks, 'b', false, cut ? '…' : undefined)}</>;
  return files ? <FileBaseContext.Provider value={files}>{out}</FileBaseContext.Provider> : out;
}
