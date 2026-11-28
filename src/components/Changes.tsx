import React, { useEffect, useRef, useState } from 'react';
import { failedWords, followOutcome, ongoing, stalledWords, WorkspaceOutcome } from '../data/outcome';
import { ApplyPreview, ApplyState, DiscardState, TurnChangesPage, TurnDiff, TurnDiffFile, UpdateState } from '../types';
import { PanelHead } from './PanelHead';
import { Button, Select } from './Controls';
import { Loading, Notice } from './Notice';
import { SESSION } from '../words';

// A file as a turn's diff or the apply preview lists it. The preview counts
// its lines; a turn's diff is counted here.
interface ChangedFile {
  path: string;
  change: string;
  added?: number;
  removed?: number;
  diff?: string;
  diff_left_out?: boolean;
}

// Files changed by a conversation or a turn, each with its diff: added lines
// green, removed lines red, hunk headers quiet.

// Past this many files, each file starts folded to its name and counts.
const FOLD_OVER = 3;

const CONFLICT = 'you changed this file since; it would be refused';

// A copy past the framework's 200,000 files (MaxSnapshotFiles) gets cut-off
// checkpoints: its changes are not real and cannot be applied.
export const TOO_BIG = 'This folder is too big to track changes (over 200,000 files)';

// The preview, or an apply, refused because the copy had more files than a
// checkpoint holds (the framework's connector.ErrTruncated).
export function refusedTooBig(msg?: string | null): boolean {
  return !!msg && msg.includes('more files than a checkpoint holds');
}

// A turn's changes list is incomplete (truncated) for two reasons: the copy
// was too big to read, or the record simply kept at most its finish bound.
// Only the first warrants the "too big" notice, and the session's preview is
// what tells them apart, so the notice shows only when the preview said so.
export function turnTooBig(truncated: boolean | undefined, sessionTooBig?: boolean): boolean {
  return !!truncated && !!sessionTooBig;
}

// One changed file: its path, kind and line counts, and its diff, which
// scrolls sideways in its own box. A file the person changed since is
// marked: an apply would refuse it.
export const FileChange: React.FC<{ file: ChangedFile; open: boolean; conflict?: string; reveal?: number }> = ({ file: f, open, conflict, reveal }) => {
  const lines = f.diff ? f.diff.replace(/\n$/, '').split('\n') : [];
  const added = f.added ?? lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = f.removed ?? lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  const counted = !!f.diff || (f.added ?? 0) + (f.removed ?? 0) > 0;
  const ref = useRef<HTMLDetailsElement>(null);
  // `open` is the fold rule (few files start open). `reveal` is a click on
  // this path: open it and bring it into view, including after the person
  // folded it. The number changes on each click, so the same file opens again.
  const [opened, setOpened] = useState(open);
  useEffect(() => {
    if (reveal === undefined) return;
    setOpened(true);
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [reveal]);
  return (
    <details
      ref={ref}
      className={`ch-file${conflict ? ' conflict' : ''}`}
      open={opened}
      onToggle={(e) => setOpened(e.currentTarget.open)}
    >
      <summary className="ch-path">
        <code>{f.path}</code> <span className={`ch-kind ${f.change}`}>{f.change}</span>
        {counted && (
          <span className="ch-count">
            <span className="ch-add">+{added}</span> <span className="ch-del">−{removed}</span>
          </span>
        )}
        {conflict && (
          <span className="ch-conflict" title={conflict}>
            {CONFLICT}
          </span>
        )}
      </summary>
      {f.diff ? (
        <pre className="ch-diff">
          <span className="ch-lines">
            {lines.map((l, i) => (
              <span key={i} className={`dl ${lineKind(l)}`}>
                {l === '' ? ' ' : l}
              </span>
            ))}
          </span>
        </pre>
      ) : f.diff_left_out ? (
        <div className="nd-note">No diff here: binary, too big, or its earlier content is not kept.</div>
      ) : null}
    </details>
  );
};

// groupByFolder splits files by the workspace's folder each path starts
// with: a session in several folders names every file by its folder's name
// first. One folder (or none known) is one group with no name.
export function groupByFolder<T extends { path: string }>(files: T[], folders?: string[]): { name: string; files: T[] }[] {
  if (!folders || folders.length < 2) return [{ name: '', files }];
  const groups = folders.map((name) => ({ name, files: files.filter((f) => f.path.startsWith(name + '/')) }));
  const rest = files.filter((f) => !folders.some((name) => f.path.startsWith(name + '/')));
  return [...groups, ...(rest.length > 0 ? [{ name: '', files: rest }] : [])].filter((g) => g.files.length > 0);
}

const FileList: React.FC<{
  files: ChangedFile[];
  truncated?: boolean;
  diffsCut?: boolean;
  conflicts?: Map<string, string>;
  // The workspace's folder names, when it has several: the files are listed
  // under each.
  folders?: string[];
  // A file a click asked to open. `n` changes on each click, including a
  // second click on the same path.
  reveal?: { path: string; n: number };
}> = ({ files, truncated, diffsCut, conflicts, folders, reveal }) => (
  <div className="ch-files">
    {groupByFolder(files, folders).map((g) => (
      <React.Fragment key={g.name}>
        {g.name && (
          <div className="ch-kind ch-folder">
            <code>{g.name}</code>
          </div>
        )}
        {g.files.map((f) => (
          <FileChange
            key={f.path}
            file={f}
            open={files.length <= FOLD_OVER}
            conflict={conflicts?.get(f.path)}
            reveal={reveal?.path === f.path ? reveal.n : undefined}
          />
        ))}
      </React.Fragment>
    ))}
    {truncated && <div className="nd-note">More files changed than are listed.</div>}
    {diffsCut && <div className="nd-note">Some diffs are left out: the changes are too big to show in full.</div>}
  </div>
);

function lineKind(l: string): string {
  if (l.startsWith('+++') || l.startsWith('---')) return 'meta';
  if (l.startsWith('@@')) return 'hunk';
  if (l.startsWith('+')) return 'add';
  if (l.startsWith('-')) return 'del';
  if (l.startsWith('\\')) return 'meta';
  return 'ctx';
}

// What the panel says while a Merge waits; a new preview clears it.
const MERGE_WAITING = 'Merging… it is waiting its turn.';
export const UPDATE_WAITING = 'Updating… it is waiting behind a running turn.';

// The message Merge puts in the box: the goal only. No file list and no
// steps: the agent finds what changed on both sides itself (SOUL v5, goals not
// procedures). It is true whatever the merge did, since it is filled before
// the merge runs.
export const MERGE_REQUEST = "My folder changed while you worked. Bring it into your work and tell me when it's ready to apply.";

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

// The turn panel's Changes tab: what this one turn changed, read-only. The
// summary is GET /api/v0/turns/<id>/diff; the files page from
// GET /api/v0/turns/<id>/changes, with Load more. Applying is done for the
// whole conversation, from the bar above the message box.
type loaded = {
  turn: string;
  files: TurnDiffFile[];
  nextBefore: number | null;
  truncated: boolean;
  diffsCut: boolean;
};
export const TurnChangesTab: React.FC<{
  turnId: string;
  // Bumps when the turn's changes change (a streamed turn.changed, its end, an
  // apply or a discard): the tab reads again, keeping what it shows until the
  // new read lands, so there is no flash of Loading. Left out: read once.
  rev?: number;
  loadDiff: () => Promise<TurnDiff>;
  loadChanges?: (before?: number) => Promise<TurnChangesPage>;
  tooBig?: boolean;
  // A file a click asked to show. `path` is the changes list's own path.
  // `n` increases on each click, including a second click on the same file.
  reveal?: { path: string; n: number };
  // The read that asked to open this tab already failed. Show that message
  // and do not read again; a later read clears it from outside.
  lookupError?: string;
}> = ({ turnId, rev, loadDiff, loadChanges, tooBig, reveal, lookupError }) => {
  const [diff, setDiff] = useState<{ turn: string; d: TurnDiff } | null>(null);
  const [changes, setChanges] = useState<loaded | null>(null);
  const [error, setError] = useState<{ turn: string; msg: string } | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // True while the first page is being read (on open, a new turn, or a rev
  // re-read). Load more is held until it lands: its cursor (nextBefore) is the
  // old page's until the new page replaces it, so a Load more begun now would
  // page from a cursor the incoming page is about to make stale and splice an
  // unrelated page in. The old files stay on screen meanwhile.
  const [reading, setReading] = useState(false);
  const diffRef = useRef(loadDiff);
  diffRef.current = loadDiff;
  const changesRef = useRef(loadChanges);
  changesRef.current = loadChanges;
  // A generation guards every async read: it is bumped on each turn change,
  // so a response for an earlier turn (an in-flight Load more, say) is ignored.
  const gen = useRef(0);
  // Cursors already requested while looking for `reveal`, so a next_before
  // that does not advance cannot page forever. Cleared when the first page
  // is replaced (a new turn, or rev).
  const paged = useRef<{ key: string; seen: Set<number> }>({ key: '', seen: new Set() });
  useEffect(() => {
    const mine = ++gen.current;
    setMoreError(null);
    setLoadingMore(false);
    // The failure is already known. Reading here would only fetch it again.
    if (lookupError) {
      setReading(false);
      return;
    }
    setReading(true);
    // The shown diff and changes are left in place until the new read lands,
    // so a re-read for the same turn (rev bumped) does not flash Loading. A
    // new turn's old data is gated out by its turn id in the render below, so
    // that case shows Loading at once.
    Promise.all([diffRef.current(), changesRef.current ? changesRef.current() : Promise.resolve(null)]).then(
      ([d, page]) => {
        if (mine !== gen.current) return;
        paged.current = { key: '', seen: new Set() };
        setDiff({ turn: turnId, d });
        setChanges(
          page
            ? { turn: turnId, files: page.changes, nextBefore: page.next_before, truncated: !!page.truncated, diffsCut: !!page.diffs_cut }
            : null
        );
        setError(null);
        setReading(false);
      },
      (err) => {
        if (mine !== gen.current) return;
        setError({ turn: turnId, msg: (err as Error).message });
        setReading(false);
      }
    );
  }, [turnId, rev, lookupError]);
  const d = diff?.turn === turnId ? diff.d : null;
  const ch = changes?.turn === turnId ? changes : null;
  const err = error?.turn === turnId ? error.msg : null;
  // A click names a file that may sit on a later page. Read forward until it
  // is listed or the pages end. The first-page read is left to finish first:
  // its cursor is the one this follows.
  useEffect(() => {
    const want = reveal?.path;
    if (lookupError || !want || !ch || reading || loadingMore || !changesRef.current) return;
    if (ch.files.some((file) => file.path === want)) return;
    if (ch.nextBefore == null) return;
    const key = `${turnId}:${reveal?.n ?? 0}`;
    if (paged.current.key !== key) paged.current = { key, seen: new Set() };
    if (paged.current.seen.has(ch.nextBefore)) return;
    paged.current.seen.add(ch.nextBefore);
    const mine = gen.current;
    const before = ch.nextBefore;
    setLoadingMore(true);
    setMoreError(null);
    changesRef.current(before).then(
      (page) => {
        if (mine !== gen.current) return;
        setChanges((c) =>
          c && c.turn === turnId
            ? { turn: turnId, files: [...c.files, ...page.changes], nextBefore: page.next_before, truncated: c.truncated || !!page.truncated, diffsCut: c.diffsCut || !!page.diffs_cut }
            : c
        );
        setLoadingMore(false);
      },
      (e) => {
        if (mine !== gen.current) return;
        setMoreError((e as Error).message);
        setLoadingMore(false);
      }
    );
  }, [reveal?.path, reveal?.n, ch, reading, loadingMore, turnId, lookupError]);
  if (lookupError) return <Notice kind="error">{lookupError}</Notice>;
  if (err) return <Notice kind="error">{err}</Notice>;
  if (!d) return <Loading />;
  const f = d.files;
  if (turnTooBig(ch?.truncated, tooBig)) {
    return (
      <div className="turn-changes">
        <Notice kind="warn" className="too-big">
          {TOO_BIG}
        </Notice>
      </div>
    );
  }
  const loadMore = () => {
    if (!ch || ch.nextBefore == null || !changesRef.current || loadingMore || reading) return;
    const mine = gen.current;
    setLoadingMore(true);
    setMoreError(null);
    changesRef.current(ch.nextBefore).then(
      (page) => {
        if (mine !== gen.current) return;
        setChanges((c) =>
          c && c.turn === turnId
            ? { turn: turnId, files: [...c.files, ...page.changes], nextBefore: page.next_before, truncated: c.truncated || !!page.truncated, diffsCut: c.diffsCut || !!page.diffs_cut }
            : c
        );
        setLoadingMore(false);
      },
      (e) => {
        if (mine !== gen.current) return;
        setMoreError((e as Error).message);
        setLoadingMore(false);
      }
    );
  };
  // The route pages the path-sorted list from the end, so sort what is loaded
  // back into path order for the screen.
  const shown = ch ? [...ch.files].sort((a, b) => a.path.localeCompare(b.path)) : [];
  return (
    <div className="turn-changes">
      <div className="tab-sum">
        <b>{f && f.count > 0 ? files(f.count) : 'No files'}</b>
        <span className="sep"> · </span>
        {f && f.count > 0 ? 'changed by this turn' : 'this turn changed no files'}
      </div>
      {f && f.count > 0 && ch && <FileList files={shown} truncated={ch.truncated} diffsCut={ch.diffsCut} reveal={reveal} />}
      {moreError && <Notice kind="error">{moreError}</Notice>}
      {ch && ch.nextBefore != null && (
        <Button kind="quiet" small onClick={loadMore} disabled={loadingMore || reading}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
};

interface ApplyPanelProps {
  // The conversation's preview: null while it is read the first time.
  preview: ApplyPreview | null;
  error?: string | null;
  // Applies the workspace's changes up to this turn (POST
  // /api/v0/workspaces/<id>/apply). Absent when the source cannot apply.
  apply?: (turn: string) => Promise<ApplyState>;
  // Reads how one action stands (GET /api/v0/workspaces/<id>/outcome?event=),
  // for the event its 202 named. Apply, Discard, Update and Merge each follow
  // their own event here until it ends; the result shown is this one's.
  readOutcome?: (event: string) => Promise<WorkspaceOutcome>;
  // Told when an apply ends, applied or not, so the preview is read again.
  onApplyEnded?: () => void;
  // Take a fresh preview (the folder may have changed outside a turn).
  onRefresh?: () => void;
  onClose?: () => void;
  pollMs?: number;
  // When set, a Review button beside Apply. It fills the message box with a
  // plain request to a reviewer -- an agent of a different vendor by default,
  // chosen from options -- and switches the picker beside Send to it; the
  // person presses Send. A shortcut, not a separate action: nothing is sent
  // here. options are the agents to offer, defaultAgent the one shown first.
  review?: {
    options: { id: string; name: string }[];
    defaultAgent: string;
    onReview: (agentId: string) => void;
    // After an Update reports files changed on both sides, the Review button
    // becomes Merge: AgentBus puts both sides in those files between conflict
    // markers (update with mode merge), then this fills the message box with a
    // plain request that the agent combine them. The person presses Send.
    onMerge?: (agentId: string, files: string[]) => void;
  };
  // On a sandbox session, drops the workspace's unapplied changes
  // (POST /api/v0/workspaces/{id}/discard). The button sits beside Apply and
  // asks once, in place, before it runs. onDiscarded carries the turns whose
  // changes were dropped, so the conversation can mark them. Absent: no
  // Discard (a direct session, or a source that cannot discard).
  discard?: () => Promise<DiscardState>;
  onDiscarded?: (droppedTurns: string[]) => void;
  // On a sandbox session whose copy fell behind the folder (an apply was
  // refused because the folder changed), brings the folder into the copy by a
  // three-way merge (POST /api/v0/workspaces/{id}/update), so the next apply
  // writes only the session's work. The button sits beside Apply when there are
  // conflicts. Absent: no update (a direct session, or a source without it).
  // With mode merge (the Merge button), a conflict leaves both sides in the
  // files for the agent to combine instead of changing nothing.
  update?: (mode?: 'merge') => Promise<UpdateState>;
  // The workspace's latest update result as the record streamed it
  // (workspace.updated): a conflict there offers Merge for the files that
  // still conflict, also when the update ended after the panel stopped
  // waiting for it.
  lastUpdate?: { result?: string; conflicts?: string[] } | null;
  // The workspace's folder names, when it has several: the files are listed
  // under each folder.
  folders?: string[];
}

// The right panel's apply preview for the conversation on screen: every
// file applying would write, its diff against the person's folder now, any
// file the person changed since (which the apply would refuse), and one
// "Apply to my folder" for the turn the preview names.
export const ApplyPanel: React.FC<ApplyPanelProps> = ({ preview, error, apply, readOutcome, onApplyEnded, onRefresh, onClose, pollMs = 2000, review, discard, onDiscarded, update, lastUpdate, folders }) => {
  // The apply this panel asked for: its turn, and its state as last read.
  const [asked, setAsked] = useState<{ turn: string; state: ApplyState | null } | null>(null);
  // The reviewer the small picker shows; empty follows review.defaultAgent.
  const [reviewer, setReviewer] = useState('');
  const [applyError, setApplyError] = useState<string | null>(null);
  // Discard asks once, in place: confirming shows the question beside Apply;
  // discarding is true while the drop runs.
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  // Update from the folder: updating while the merge runs, a plain result line
  // (updated, or N files still conflict), and an error.
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  // The files the workspace's latest update found changed on both sides: from
  // this panel's own Update reply or the record's workspace.updated, whichever
  // came last. Merge offers those that the preview still refuses, so a new
  // preview never drops them while they conflict, and a later conflict in
  // other files gets Update, not this one's Merge. gen counts each new result,
  // so a Merge reply clears only the result it was asked against.
  const [conflictFiles, setConflictFiles] = useState<string[] | null>(null);
  const gen = useRef(0);
  // A Merge the API answered as queued: the result it waits on (gen), so the
  // button stays held until the record's next update result arrives.
  const [waitingOn, setWaitingOn] = useState<number | null>(null);
  const takeUpdate = (files: string[] | null) => {
    gen.current++;
    setConflictFiles(files);
  };
  useEffect(() => {
    if (lastUpdate) takeUpdate(lastUpdate.result === 'conflict' ? lastUpdate.conflicts ?? [] : null);
  }, [lastUpdate]);
  const previewKey: unknown = preview?.previewed_at ?? preview;
  useEffect(() => {
    setUpdateMsg((m) => (m === MERGE_WAITING ? null : m));
  }, [previewKey]);
  const [merging, setMerging] = useState(false);
  const endedRef = useRef(onApplyEnded);
  endedRef.current = onApplyEnded;
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const state = asked?.state;
  const pending = !!asked && (!state || ongoing(state.state));

  // While mounted, a follow keeps reading; after, it stops.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Follows one action's 202 to its end on the outcome route. A reply that
  // already ended (an older service's 200) is its own outcome.
  const follow = (s: { state?: string; event?: string }, onWait?: (o: WorkspaceOutcome) => void) =>
    followOutcome(s, readOutcome, { pollMs, onWait, active: () => mounted.current });

  const doApply = async () => {
    if (!apply || !preview?.turn) return;
    const turn = preview.turn;
    const at = Date.now();
    setAsked({ turn, state: null });
    setApplyError(null);
    try {
      const s = await apply(turn);
      setAsked({ turn, state: s });
      const o = await follow(s, (w) => setAsked({ turn, state: { ...w, state: w.state } as ApplyState }));
      if (o.state === 'gone') return;
      if (o.state === 'stalled') {
        setAsked(null);
        setApplyError(stalledWords('apply', at));
        return;
      }
      setAsked({ turn, state: o as ApplyState });
      endedRef.current?.();
    } catch (err) {
      setAsked(null);
      setApplyError((err as Error).message);
    }
  };

  const doDiscard = async () => {
    if (!discard) return;
    const at = Date.now();
    setDiscarding(true);
    setDiscardError(null);
    try {
      const o = await follow(await discard());
      if (o.state === 'gone') return;
      if (o.state === 'failed') {
        setDiscardError(failedWords('discard', o));
      } else if (o.state === 'stalled') {
        setDiscardError(stalledWords('discard', at));
      } else {
        setConfirming(false);
        // The turns whose changes went, from the outcome of this discard.
        onDiscarded?.(o.dropped_turns ?? []);
        endedRef.current?.();
      }
    } catch (err) {
      setDiscardError((err as Error).message);
    } finally {
      if (mounted.current) setDiscarding(false);
    }
  };

  // While an update or a merge waits, the outcome says why, in these words.
  const waitWords = (w: WorkspaceOutcome, queued: string) => (w.state === 'queued' ? queued : 'Updating…');
  const updatedMsg = `Updated from your folder. Apply now writes only this ${SESSION}'s work.`;
  const conflictPaths = (o: WorkspaceOutcome) => (o.conflicts ?? []).map((c) => (typeof c === 'string' ? c : (c as { path?: string })?.path)).filter((p): p is string => !!p);

  const doUpdate = async () => {
    if (!update) return;
    const at = Date.now();
    setUpdating(true);
    setUpdateError(null);
    setUpdateMsg(null);
    try {
      const o = await follow(await update(), (w) => setUpdateMsg(waitWords(w, UPDATE_WAITING)));
      if (o.state === 'gone') return;
      setUpdateMsg(null);
      if (o.updated || o.state === 'updated') {
        // The folder is merged in: take a fresh preview, which now shows the
        // session's work against the folder as it is, with no conflicts.
        setUpdateMsg(updatedMsg);
        (refreshRef.current ?? endedRef.current)?.();
      } else if (o.state === 'conflict') {
        // Said in the warning at the top; the way forward is Merge.
        takeUpdate(conflictPaths(o));
      } else if (o.state === 'stalled') {
        setUpdateError(stalledWords('update', at));
      } else {
        setUpdateError(failedWords('update', o));
      }
    } catch (err) {
      setUpdateError((err as Error).message);
    } finally {
      if (mounted.current) setUpdating(false);
    }
  };

  // Merge fills the message box at once, as Review does, so nothing the
  // person types after is overwritten. When the files do not hold the merge's
  // markers yet, it then asks AgentBus to put both sides in them (update, mode
  // merge), and follows that to its outcome; the next preview shows what it did.
  const doMerge = async (agentId: string, paths: string[], call: boolean) => {
    review?.onMerge?.(agentId, paths);
    if (!call || !update) return;
    // The result this click was on: a reply clears only it, never a newer one
    // that came meanwhile.
    const asked = gen.current;
    const at = Date.now();
    const markCalled = () => {
      if (gen.current === asked) takeUpdate(null);
    };
    setMerging(true);
    setUpdateError(null);
    setUpdateMsg(null);
    try {
      const o = await follow(await update('merge'), (w) => {
        // Merge is held, not asked for twice, while it waits.
        if (gen.current === asked) setWaitingOn(asked);
        setUpdateMsg(waitWords(w, MERGE_WAITING));
      });
      if (o.state === 'gone') return;
      setWaitingOn(null);
      setUpdateMsg(null);
      if (o.state === 'merged' || o.state === 'updated' || o.updated) {
        markCalled();
        if (o.state !== 'merged') setUpdateMsg(updatedMsg);
        (refreshRef.current ?? endedRef.current)?.();
      } else if (o.state === 'conflict') {
        // Markers could not show some files (unmergeable): error says so.
        if (o.error) setUpdateError(o.error);
      } else if (o.state === 'stalled') {
        setUpdateError(stalledWords('update', at));
      } else {
        setUpdateError(failedWords('update', o));
      }
    } catch (err) {
      setUpdateError((err as Error).message);
    } finally {
      if (mounted.current) setMerging(false);
    }
  };

  // After an apply, the panel says so until a later turn has new work. A stale
  // preview is never "applied, folder matches": it is out of date (the session
  // changed and the runner is offline), so the panel shows that, its time and
  // Refresh, whatever the last apply was.
  const applied =
    state?.state === 'applied' && !preview?.stale && (!preview || !preview.unapplied || preview.turn === asked!.turn);
  const refused = state && (state.state === 'refused' || state.state === 'failed') ? state : null;
  // The copy is too big to track: no count, no files, no apply.
  const tooBig = refusedTooBig(error) || refusedTooBig(refused?.error);
  // Each file an apply would refuse, by path.
  const conflicts = preview?.conflicts ?? [];
  const conflictOf = new Map(conflicts.map((c) => [c.path, c.why]));
  const conflicted = conflicts.length > 0;
  const has = !!preview && preview.unapplied && (preview.count > 0 || preview.files.length > 0 || conflicted);
  const canApply = !!apply && !!preview?.turn && has && !pending && !conflicted && !tooBig;
  // The reviewer offered beside Apply: the small picker's choice, or the
  // default (an agent of a different vendor). Review stays available even
  // when an apply would be refused -- a person can ask about it regardless.
  const reviewers = review?.options ?? [];
  const reviewerId = reviewers.some((o) => o.id === reviewer) ? reviewer : review?.defaultAgent ?? '';
  const canReview = reviewers.length > 0 && has && !tooBig;
  // How many files would be dropped, for the confirm question. Discard drops
  // the copy's changes whether or not a file in the folder also changed, so a
  // conflict does not block it.
  const changedCount = preview ? preview.count || preview.files.length : 0;
  const canDiscard = !!discard && has && !pending && !discarding && !tooBig;
  // Update is offered when an apply would be refused because the folder changed
  // since the copy was made: it brings the folder in so the apply can go.
  // Merge stands in for Review while files still hold the merge's markers
  // (from the preview), or once an Update against this very preview found
  // files changed on both sides. Neither outlives the preview it came from.
  const markerFiles = conflicts.filter((c) => c.markers).map((c) => c.path);
  const refusedNow = new Set(conflicts.filter((c) => !c.markers).map((c) => c.path));
  const bothSides = (conflictFiles ?? []).filter((p) => refusedNow.has(p));
  const mergeFiles = markerFiles.length > 0 ? markerFiles : bothSides.length > 0 ? bothSides : null;
  const mergeCall = markerFiles.length === 0 && bothSides.length > 0;
  const canMerge = !!mergeFiles && !!review?.onMerge;
  // Update helps only with a file the folder changed; a file holding markers
  // needs the agent.
  const canUpdate =
    !!update && conflicts.some((c) => !c.markers) && !pending && !updating && !discarding && !tooBig;
  const reviewerName = reviewers.find((o) => o.id === reviewerId)?.name ?? 'the agent';

  return (
    <section id="right" className="apply-panel">
      <PanelHead up={[]} onClose={onClose}>
        {has && !applied ? 'Changes not applied' : 'Changes'}
      </PanelHead>
      <div id="d-body">
        {tooBig ? (
          <Notice kind="warn" className="too-big">
            {TOO_BIG}
          </Notice>
        ) : (
          <>
            {error && <Notice kind="error">{error}</Notice>}
            {!preview && !error && <Loading />}
            {applied ? (
              <p className="nd-note ok" role="status">Applied. Your folder matches this {SESSION}.</p>
            ) : (
              preview && (
                <>
                  <div className="tab-sum">
                    <b>{has ? files(preview.count || preview.files.length) : 'Nothing to apply'}</b>
                    <span className="sep"> · </span>
                    {has
                      ? 'would be written to your folder, each against what it holds now'
                      : preview.why || `your folder matches this ${SESSION}`}
                  </div>
                  {preview.previewed_at && (
                    <div className="nd-note ap-asof">
                      As of {new Date(preview.previewed_at).toLocaleString()}
                      {onRefresh && (
                        <>
                          {' · '}
                          <Button kind="link" small onClick={onRefresh}>
                            Refresh
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                  {preview.stale && (
                    <Notice kind="warn" className="ap-stale">
                      <b>Out of date.</b>{' '}
                      {preview.why || `The ${SESSION} changed after this preview was taken.`}
                    </Notice>
                  )}
                  {conflicted && (
                    <Notice kind="warn" className="ap-conflicts">
                      <b>{files(conflicts.length)} would be refused.</b> You changed{' '}
                      {conflicts.length === 1 ? 'this file' : 'these files'} in your folder since this {SESSION} copied it:
                      <ul className="ch-conflicts">
                        {conflicts.map((c) => (
                          <li key={c.path}>
                            <code>{c.path}</code>: {c.why}
                          </li>
                        ))}
                      </ul>
                      {mergeFiles && (
                        <p className="ap-merge">
                          {files(mergeFiles.length)} changed on both sides.{' '}
                          {canMerge ? `Merge asks ${reviewerName} to combine them, then Apply.` : 'Ask the agent to combine them, then Apply.'}
                        </p>
                      )}
                    </Notice>
                  )}
                  {has && (
                    <FileList files={preview.files} truncated={preview.truncated} diffsCut={preview.diffs_cut} conflicts={conflictOf} folders={folders} />
                  )}
                  {preview.count > preview.files.length && (
                    <div className="nd-note ap-more">
                      {preview.count - preview.files.length} more files not listed{preview.truncated ? ': too many to send' : ''}
                    </div>
                  )}
                </>
              )
            )}
            {refused && (
              <Notice kind="error" className={refused.state === 'failed' ? 'ap-failed' : 'ap-refused'}>
                {/* Refused: files changed in the folder, each listed with why.
                    Failed (workspace.failed): it did not run, in plain words. */}
                {refused.state === 'failed' ? failedWords('apply', refused) : refused.error || 'The apply was refused.'}
                {refused.conflicts && refused.conflicts.length > 0 && (
                  <ul className="ch-conflicts">
                    {refused.conflicts.map((c) => (
                      <li key={c.path}>
                        <code>{c.path}</code>: {c.why}
                      </li>
                    ))}
                  </ul>
                )}
              </Notice>
            )}
            {applyError && <Notice kind="error">{applyError}</Notice>}
            {discardError && <Notice kind="error">{discardError}</Notice>}
            {updateError && <Notice kind="error">{updateError}</Notice>}
            {updateMsg && (
              <p className="nd-note" role="status">
                {updateMsg}
              </p>
            )}
          </>
        )}
      </div>
      {/* The bar stays at the panel's foot; the list above it scrolls in #d-body. */}
      {!tooBig && !applied && has && (apply || canReview || discard || update) && (
        <div className="ap-actions">
          {canReview && !confirming && (
            <span className="ap-review">
              <Select
                name="reviewer"
                variant="quiet"
                label="Agent to review these changes"
                title="Agent to review these changes"
                value={reviewerId}
                options={reviewers.map((o) => ({ value: o.id, label: o.name }))}
                onChange={setReviewer}
                align="right"
              />
              {canMerge ? (
                <Button
                  kind="secondary"
                  className="ap-merge-go"
                  disabled={merging || pending || waitingOn === gen.current}
                  onClick={() => doMerge(reviewerId, mergeFiles!, mergeCall)}
                >
                  {merging ? 'Merging…' : 'Merge'}
                </Button>
              ) : (
                <Button kind="secondary" onClick={() => review?.onReview(reviewerId)}>
                  Review
                </Button>
              )}
            </span>
          )}
          {confirming ? (
            // The question in place, no pop-up window: Discard N files?
            <span className="ap-confirm" role="group" aria-label="Discard changes">
              <span className="ap-confirm-q">Discard {files(changedCount)}?</span>
              <Button kind="secondary" className="ap-discard-no" onClick={() => setConfirming(false)} disabled={discarding}>
                Cancel
              </Button>
              <Button kind="secondary" className="ap-discard-go" onClick={doDiscard} disabled={discarding}>
                {discarding ? 'Discarding…' : 'Discard'}
              </Button>
            </span>
          ) : (
            <span className="ap-right">
              {update && !mergeFiles && (
                <Button
                  kind="secondary"
                  className="ap-update"
                  disabled={!canUpdate}
                  title="Bring your folder's current changes into this copy, then apply only this conversation's work"
                  onClick={doUpdate}
                >
                  {updating ? 'Updating…' : 'Update from my folder'}
                </Button>
              )}
              {discard && (
                <Button
                  kind="secondary"
                  className="ap-discard"
                  disabled={!canDiscard}
                  title="Drop these changes and reset the copy"
                  onClick={() => {
                    setDiscardError(null);
                    setConfirming(true);
                  }}
                >
                  Discard
                </Button>
              )}
              {apply && (
                <Button kind="primary" accent className="ap-apply" disabled={!canApply} onClick={doApply} title="Apply these changes to your folder">
                  {pending ? 'Applying…' : 'Apply'}
                </Button>
              )}
            </span>
          )}
        </div>
      )}
    </section>
  );
};
