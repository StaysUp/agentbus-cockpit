// A conversation's record as one .jsonl file: one event per line, oldest
// first, as GET /api/v0/sessions/<id>/events sends them. For a bug report, a
// backup or the person's own scripts.

// The file's name: the conversation's name, made safe for a file name, then
// its id. A conversation with no name of its own (its title is its id) is
// named by its id alone.
export function recordFileName(title: string, id: string): string {
  const name = title === id ? '' : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return `${name ? `${name}-` : ''}${id}.jsonl`;
}

// The file's text: each event on its own line, and a newline at the end.
export function recordText(events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');
}

// Hands the browser the file to save.
export function saveRecord(name: string, events: unknown[]): void {
  const url = URL.createObjectURL(new Blob([recordText(events)], { type: 'application/x-ndjson' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
