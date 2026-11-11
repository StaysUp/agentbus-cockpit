import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Block, blocksOf, layoutContext, leafTools, MessageRow, PieceRow, ReplayGroup, splitReplayed, sum, Sum, toolCount, turnInfo } from '../data/context';
import { CallContext, ContextPiece, TurnDetail } from '../types';

export type LoadContext = (turn: string, exchange: string, full: boolean) => Promise<CallContext>;

interface ContextTabProps {
  // The turn the call belongs to: the API reads a call by its turn.
  turn: string;
  // The call's exchange; undefined when its events carry none.
  exchange?: string;
  // undefined when the data source keeps no request bodies.
  load?: LoadContext;
  // `replayed` on the call's model.requested.
  replayed?: number;
  continuity?: 'replay' | 'resume';
  // The id of the turn named by replay_from on the call's turn.
  replayFrom?: string;
  // The session's turns, to number the groups and to read the ones whose
  // events are already loaded.
  turns?: { id: string; turnNumber: number; detail?: TurnDetail }[];
  // Reads a turn's events when the list holds none. Left out when the
  // source cannot.
  loadTurn?: (turnId: string) => Promise<TurnDetail | null>;
  // Set when that turn did not finish (recovered_from on turn.started).
  recovered?: boolean;
}

// A request at or under this size is read whole right after its outline.
// A larger one waits until something that needs its text is opened.
export const AUTO_FULL_BYTES = 1_000_000;

// Reads stay for the session: a stored call never changes. Keyed by the
// loader, so two sources never share an answer.
const cache = new WeakMap<LoadContext, Map<string, CallContext>>();

function cached(load: LoadContext, key: string): CallContext | undefined {
  return cache.get(load)?.get(key);
}

function keep(load: LoadContext, key: string, ctx: CallContext) {
  let m = cache.get(load);
  if (!m) {
    m = new Map();
    cache.set(load, m);
  }
  m.set(key, ctx);
}

type Read = { ctx?: CallContext; error?: string; loading?: boolean };

const bytes = (n: number) => `${n.toLocaleString()} B`;
const TOK_TITLE = "The service's estimate (bytes ÷ 2.66), not the model's own count. The exact count of the whole call is Tokens above.";

const Tok: React.FC<{ n: number | null | undefined }> = ({ n }) =>
  typeof n === 'number' ? (
    <span className="ctx-tok" title={TOK_TITLE}>
      ≈{Math.round(n).toLocaleString()} tok
    </span>
  ) : null;

const SumMeta: React.FC<{ s: Sum; noun?: string; count?: number }> = ({ s, noun, count }) => (
  <>
    {noun && (
      <span>
        {count ?? s.count} {noun}
      </span>
    )}
    <span>{bytes(s.size)}</span>
    <Tok n={s.approxTokens} />
  </>
);

// One foldable row. Its body is only built while it is open, so a folded
// block of any size costs nothing to render.
const Fold: React.FC<{
  title: React.ReactNode;
  meta?: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  // byUser: the person opened it, rather than it opening by default.
  children: (byUser: boolean) => React.ReactNode;
}> = ({ title, meta, defaultOpen = false, className = '', children }) => {
  const [open, setOpen] = useState(defaultOpen);
  const [byUser, setByUser] = useState(false);
  return (
    <div className={`ctx-fold ${open ? 'open' : ''} ${className}`}>
      <button
        className="ctx-row"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setByUser(true);
        }}
      >
        <span className="ctx-chev">{open ? '▾' : '▸'}</span>
        <span className="ctx-title">{title}</span>
        {meta && <span className="ctx-meta">{meta}</span>}
      </button>
      {open && <div className="ctx-inner">{children(byUser)}</div>}
    </div>
  );
};

// Text longer than this opens cut to its start; the rest comes in pages.
export const LONG_CHARS = 2000;
const HEAD_CHARS = 600;
const PAGE_CHARS = 100_000;

export const LongText: React.FC<{ text: string }> = ({ text }) => {
  const [shown, setShown] = useState(text.length > LONG_CHARS ? HEAD_CHARS : text.length);
  const rest = text.length - shown;
  return (
    <>
      <pre className="ctx-text">
        {text.slice(0, shown)}
        {rest > 0 && '…'}
      </pre>
      {rest > 0 && (
        <button className="ctx-more" onClick={() => setShown((s) => Math.min(text.length, s + PAGE_CHARS))}>
          {rest > PAGE_CHARS
            ? `Show ${PAGE_CHARS.toLocaleString()} more chars (${rest.toLocaleString()} left)`
            : `Show the rest (${rest.toLocaleString()} chars)`}
        </button>
      )}
    </>
  );
};

const blockTitle = (b: Block) => {
  if (b.type === 'tool_use' || b.type === 'function_call' || b.type === 'custom_tool_call') return `${b.type} ${b.name ?? ''}`.trim();
  if (b.claudeCode && b.type === 'text') return `${b.harness ?? 'Claude Code'} text`;
  return b.type;
};

const BlockView: React.FC<{ b: Block; open: boolean }> = ({ b, open }) => (
  <Fold
    className={b.claudeCode ? 'cc' : ''}
    title={blockTitle(b)}
    meta={<span>{b.note ?? `${b.text.length.toLocaleString()} chars`}</span>}
    defaultOpen={open}
  >
    {() => <LongText text={b.text} />}
  </Fold>
);

// Shown where a piece's text is needed but not read. Asking for it (the
// person opened the row, or the call is small) starts the full read.
const NeedText: React.FC<{ ask: boolean; need: () => void; full: Read; size?: number }> = ({ ask, need, full, size }) => {
  useEffect(() => {
    if (ask) need();
  }, [ask, need]);
  if (full.error) return <p className="bad ctx-err">The text could not be read: {full.error}</p>;
  if (full.loading || ask) return <p className="dim">Reading the text…</p>;
  return (
    <button className="ctx-more" onClick={need}>
      Read the text{size !== undefined ? ` (${bytes(size)} for the whole call)` : ''}
    </button>
  );
};

interface BodyProps {
  piece: ContextPiece | undefined;
  need: () => void;
  full: Read;
  // Read the text now if it is missing.
  ask: boolean;
  callSize: number;
}

// A message piece's content, block by block.
const PieceBody: React.FC<BodyProps & { role: string }> = ({ piece, role, need, full, ask, callSize }) => {
  if (piece?.json === undefined) return <NeedText ask={ask} need={need} full={full} size={callSize} />;
  const blocks = blocksOf(piece.json, role);
  // Open what the person and the model wrote; fold Claude Code's material.
  const openOne = blocks.length === 1 && !blocks[0].claudeCode;
  return (
    <div className="ctx-blocks">
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} open={openOne || (!b.claudeCode && b.text.length <= LONG_CHARS)} />
      ))}
    </div>
  );
};

// A system block, a tool or the request's other fields.
const JsonBody: React.FC<BodyProps> = ({ piece, need, full, ask, callSize }) => {
  if (piece?.json === undefined) return <NeedText ask={ask} need={need} full={full} size={callSize} />;
  const j = piece.json as Record<string, unknown>;
  const text = typeof j === 'string' ? j : typeof j === 'object' && j && typeof j.text === 'string' ? j.text : JSON.stringify(j, null, 2);
  return <LongText text={text} />;
};

// codex's tools item: one fold per tool, namespaces flattened.
const ToolsItemBody: React.FC<BodyProps> = ({ piece, need, full, ask, callSize }) => {
  if (piece?.json === undefined) return <NeedText ask={ask} need={need} full={full} size={callSize} />;
  const leaves = leafTools(piece.json);
  if (!leaves) return <LongText text={JSON.stringify(piece.json, null, 2)} />;
  return (
    <>
      {leaves.map((t, i) => {
        const text = JSON.stringify(t.json, null, 2);
        return (
          <Fold key={i} title={t.name} meta={<span>{text.length.toLocaleString()} chars</span>}>
            {() => <LongText text={text} />}
          </Fold>
        );
      })}
    </>
  );
};

export const ContextTab: React.FC<ContextTabProps> = ({ turn, exchange, load, replayed, continuity, replayFrom, turns, loadTurn, recovered }) => {
  const [light, setLight] = useState<Read>({ loading: true });
  const [full, setFull] = useState<Read>({});

  // The exchange on screen, and the one whose full read has started. A read
  // that comes back for another exchange is dropped.
  const current = useRef<string | undefined>(exchange);
  const started = useRef<string | null>(null);
  current.current = exchange;

  // The outline first (full=false), unless the whole call is already read.
  useEffect(() => {
    if (!load || !exchange) return;
    const whole = cached(load, `${turn}|${exchange}|full`);
    if (whole) {
      started.current = exchange;
      setLight({ ctx: whole });
      setFull({ ctx: whole });
      return;
    }
    started.current = null;
    setFull({});
    const outline = cached(load, `${turn}|${exchange}|light`);
    if (outline) {
      setLight({ ctx: outline });
      return;
    }
    let live = true;
    setLight({ loading: true });
    load(turn, exchange, false).then(
      (ctx) => {
        keep(load, `${turn}|${exchange}|light`, ctx);
        if (live) setLight({ ctx });
      },
      (e: unknown) => {
        if (live) setLight({ error: e instanceof Error ? e.message : String(e) });
      }
    );
    return () => {
      live = false;
    };
  }, [load, turn, exchange]);

  // Reads the whole call once per exchange; a failed read is not retried.
  const needFull = useCallback(() => {
    if (!load || !exchange || started.current === exchange) return;
    started.current = exchange;
    setFull({ loading: true });
    load(turn, exchange, true).then(
      (ctx) => {
        keep(load, `${turn}|${exchange}|full`, ctx);
        if (current.current === exchange) setFull({ ctx });
      },
      (e: unknown) => {
        if (current.current === exchange) setFull({ error: e instanceof Error ? e.message : String(e) });
      }
    );
  }, [load, turn, exchange]);

  // A small call is read whole straight away, so the open parts fill in.
  useEffect(() => {
    if (light.ctx && !full.ctx && light.ctx.size <= AUTO_FULL_BYTES) needFull();
  }, [light.ctx, full.ctx, needFull]);

  const shown = full.ctx ?? light.ctx;
  const layout = useMemo(() => (shown ? layoutContext(shown, { replayed, continuity }) : null), [shown, replayed, continuity]);

  // The replayed messages split by the turn each came from. Until the walk
  // is done they show as one group.
  const replayedCount = layout?.replayed ?? 0;
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const loadTurnRef = useRef(loadTurn);
  loadTurnRef.current = loadTurn;
  const [groups, setGroups] = useState<{ key: string; groups: ReplayGroup[] } | null>(null);
  const groupKey = `${exchange}|${replayedCount}|${continuity}|${replayFrom}`;
  useEffect(() => {
    if (replayedCount === 0) return;
    let live = true;
    const getInfo = async (id: string) => {
      const known = turnsRef.current?.find((t) => t.id === id);
      if (!known) return undefined;
      const detail = known.detail ?? (await loadTurnRef.current?.(id)) ?? undefined;
      return detail ? turnInfo(detail.events) : undefined;
    };
    splitReplayed(replayedCount, continuity === 'resume' ? undefined : replayFrom, getInfo).then((g) => {
      if (live) setGroups({ key: groupKey, groups: g });
    });
    return () => {
      live = false;
    };
  }, [groupKey, replayedCount, continuity, replayFrom]);

  if (!load) return <p className="dim">This source keeps no request bodies. The live service serves them.</p>;
  if (!exchange) return <p className="dim">This call names no exchange, so its request cannot be read.</p>;
  if (light.error) return <p className="bad ctx-err">The request could not be read: {light.error}</p>;
  if (!shown || !layout) return <p className="dim">Reading the request…</p>;

  const piece = (i: number) => shown.pieces[i];
  // A row the person opened reads the text; one open by default waits for a
  // click when the call is too large to read straight away.
  const small = shown.size <= AUTO_FULL_BYTES;
  const bodyProps = (byUser: boolean) => ({ need: needFull, full, ask: byUser || small, callSize: shown.size });
  const model = typeof shown.request?.model === 'string' ? shown.request.model : undefined;
  const all = sum(shown.pieces);
  // The tools item and the base instructions of a codex call show in the
  // Tools and System sections; they keep their numbers in the groups' ranges.
  const inSection = (m: MessageRow) => m.item === 'system' || m.item === 'tools';
  const replayedRows = layout.messages.filter((m) => m.part === 'replayed' && !inSection(m));
  const others = layout.messages.filter((m) => m.part !== 'replayed' && !inSection(m));
  const replayedGroups: ReplayGroup[] =
    groups && groups.key === groupKey
      ? groups.groups
      : replayedRows.length > 0
        ? [{ kind: 'earlier', from: 0, to: replayedRows.length, why: 'Reading the turns it came from…' }]
        : [];
  const otherFields = shown.request ? Object.keys(shown.request) : [];

  const msgTitle = (m: MessageRow) => (
    <>
      <span className="ctx-idx">#{m.index}</span> {m.role}
      {m.part === 'new' && <span className="ctx-tag new">new message</span>}
      {m.claudeCode && <span className="ctx-tag cc">Claude Code</span>}
      {m.item === 'context' && <span className="ctx-tag cc">Codex context</span>}
      {m.item === 'note' && <span className="ctx-tag">AgentBus note</span>}
    </>
  );
  const msgMeta = (p: ContextPiece) => (
    <>
      <span>{bytes(p.size)}</span>
      <Tok n={p.approx_tokens} />
    </>
  );
  const message = (m: MessageRow, open: boolean) => (
    <Fold key={`${m.pieceIndex}-${m.part}`} className={`msg-${m.part} ${m.claudeCode || m.item === 'context' ? 'cc' : ''}`} title={msgTitle(m)} meta={msgMeta(m.piece)} defaultOpen={open}>
      {(byUser) => <PieceBody piece={piece(m.pieceIndex)} role={m.role} {...bodyProps(byUser)} />}
    </Fold>
  );
  const pieceRow = (r: PieceRow) => (
    <Fold key={r.pieceIndex} title={r.item ? (r.item.item === 'tools' ? 'Tools item' : 'Base instructions') : r.piece.label || r.piece.kind} meta={msgMeta(r.piece)}>
      {(byUser) =>
        r.item?.item === 'tools' ? (
          <ToolsItemBody piece={piece(r.pieceIndex)} {...bodyProps(byUser)} />
        ) : r.item ? (
          <PieceBody piece={piece(r.pieceIndex)} role={r.item.role} {...bodyProps(byUser)} />
        ) : (
          <JsonBody piece={piece(r.pieceIndex)} {...bodyProps(byUser)} />
        )
      }
    </Fold>
  );
  const nTools = toolCount(layout.tools);

  return (
    <div className="ctx">
      <div className="ctx-sum">
        <span title="The whole request body, with fields that are not pieces">{bytes(shown.size)} request</span>
        <span>
          {all.count} pieces, {bytes(all.size)}
        </span>
        {model && <code>{model}</code>}
        <Tok n={all.approxTokens} />
        {!full.ctx && !full.loading && (
          <button className="ctx-more" onClick={needFull}>
            Read the text ({bytes(shown.size)})
          </button>
        )}
        {full.loading && <span className="dim">reading the text…</span>}
      </div>
      {full.error && <p className="bad ctx-err">The text could not be read: {full.error}</p>}
      {continuity === 'resume' && (
        <p className="note">Continued by the vendor's resume. Earlier turns are inside these messages, and nothing marks where they end.</p>
      )}

      <div className="sub-h first">Request</div>
      {layout.system.length > 0 && (
        <Fold title="System" meta={<SumMeta s={sum(layout.system.map((r) => r.piece))} noun={layout.system.length === 1 ? 'block' : 'blocks'} />}>
          {() => layout.system.map(pieceRow)}
        </Fold>
      )}
      {layout.tools.length > 0 && (
        <Fold title="Tools" meta={<SumMeta s={sum(layout.tools.map((r) => r.piece))} noun={nTools === undefined ? undefined : 'tools'} count={nTools} />}>
          {() => layout.tools.map(pieceRow)}
        </Fold>
      )}
      {replayedGroups.map((g, i) => {
        const rows = replayedRows.filter((m) => m.index >= g.from && m.index < g.to);
        if (rows.length === 0) return null;
        const num = g.turnId !== undefined ? turns?.find((t) => t.id === g.turnId)?.turnNumber : undefined;
        const title = g.kind === 'turn' ? (num !== undefined ? `Turn ${num}` : 'An earlier turn') : 'Earlier history';
        return (
          <Fold
            key={`${g.kind}-${g.turnId ?? ''}-${g.from}`}
            className="replayed"
            title={title}
            meta={<SumMeta s={sum(rows.map((m) => m.piece))} noun={rows.length === 1 ? 'message' : 'messages'} />}
          >
            {() => (
              <>
                <p className="note">
                  {g.kind === 'turn'
                    ? `Put in front by the gateway from ${num !== undefined ? `turn ${num}` : 'an earlier turn'}'s stored history.`
                    : `Put in front by the gateway. ${g.why ?? ''}`}
                  {g.kind === 'turn' && i === replayedGroups.length - 1 && recovered && ' That turn did not finish, so the history ends with a note from AgentBus.'}
                </p>
                {rows.map((m) => message(m, false))}
              </>
            )}
          </Fold>
        );
      })}
      {others.map((m) => message(m, m.part === 'new'))}
      {otherFields.length > 0 && (
        <Fold title="Other fields" meta={<span>{otherFields.slice(0, 4).join(', ') + (otherFields.length > 4 ? ', …' : '')}</span>}>
          {() => <LongText text={JSON.stringify(shown.request, null, 2)} />}
        </Fold>
      )}

      <div className="sub-h">Reply</div>
      {shown.reply ? (
        <Fold
          className="reply-piece"
          defaultOpen
          title={
            <>
              {shown.reply.label || 'reply'}
              {shown.stop_reason && <code className="ctx-stop">{shown.stop_reason}</code>}
            </>
          }
          meta={msgMeta(shown.reply)}
        >
          {(byUser) => <PieceBody piece={shown.reply} role={shown.reply!.label} {...bodyProps(byUser)} />}
        </Fold>
      ) : (
        <p className="dim">
          No reply is kept for this call{shown.stop_reason ? ` (stop reason ${shown.stop_reason})` : ''}: it was not 200, ended early, or came in a form the
          gateway cannot rebuild.
        </p>
      )}
    </div>
  );
};
