import React, { useEffect, useState } from 'react';
import { LOADING } from '../words';
import { formatCount } from '../utils/format';
import { ContextMeter } from './ContextMeter';
import { ContextPart, SessionContext, TurnContext } from '../types';

// The practical context view, beside the Model calls debugging detail: how
// full this turn's context got against the window, the few facts that support
// it, what its largest prompt was made of, and where the turn sits on the
// session's growth. It reads GET /turns/{id}/context and GET
// /sessions/{id}/context; the numbers are the record's, computed on request.
// Built from the cockpit's own tab pieces — tab-sum, strip, sub-h, the grid —
// so it reads as the other tabs do.

interface Props {
  session: string;
  turn: string;
  loadTurn: (session: string, turn: string) => Promise<TurnContext>;
  loadSession: (session: string, before?: number) => Promise<SessionContext>;
  // Bumps when the turn's data changes (a streamed turn.changed, its end, an
  // apply or a discard): the view reads again, keeping what it shows until the
  // new read lands, so a settled turn is current without a Refresh and without
  // a flash of Loading. Left out: read once.
  rev?: number;
}

// Follows a session's context pages (the server pages them; newest first) to
// the end, gathering every turn's growth, so the chart holds the whole history.
// The totals are the same on every page. A guard stops a runaway cursor.
async function wholeSession(load: Props['loadSession'], session: string): Promise<SessionContext> {
  const first = await load(session);
  const growth = [...first.growth];
  let next = first.next_before;
  const seen = new Set<number>();
  while (next != null && !seen.has(next)) {
    seen.add(next);
    const page = await load(session, next);
    growth.push(...page.growth);
    next = page.next_before;
  }
  return { ...first, growth, next_before: null };
}

// A plain name for one part of a prompt, from its piece kind and label.
export function partLabel(p: ContextPart): string {
  if (p.kind === 'system' || p.kind === 'instructions') return 'System prompt';
  if (p.kind === 'tool') return p.count > 1 ? `Tool definitions (${p.count})` : 'Tool definition';
  if (p.kind === 'message' || p.kind === 'input_item') {
    if (p.label === 'user') return 'Your messages & tool results';
    if (p.label === 'assistant') return 'Model replies';
    if (p.label) return `Conversation · ${p.label}`;
    return 'Conversation';
  }
  return p.label ? `${p.kind} · ${p.label}` : p.kind;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

// The made_of parts as a plain table, largest first: the same grid the Model
// calls tab uses. No stacked bar, no swatches, no caption.
const MadeOf: React.FC<{ ctx: TurnContext }> = ({ ctx }) => {
  const made = ctx.made_of;
  if (!made) return <p className="dim">No request body kept for this turn's largest call.</p>;
  const whole = made.approx_tokens;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Part</th>
          <th className="r">Tokens</th>
          <th className="r">Share</th>
        </tr>
      </thead>
      <tbody>
        {made.parts.map((p) => (
          <tr key={`${p.kind}-${p.label ?? ''}`}>
            <td>{partLabel(p)}</td>
            <td className="r">~{formatCount(p.approx_tokens)}</td>
            <td className="r">{pct(p.approx_tokens, whole)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// The session's growth: one thin bar per turn, oldest first, each as tall as
// its context, the current turn in ink. Later turns carry the earlier ones, so
// the bars rise across the session. Scaled to the session peak, in tokens: a
// session's turns can run different models, and the session view carries no
// per-turn window, so a single window here would be wrong. The per-turn meter
// above is where fullness-against-the-window is shown.
const Growth: React.FC<{ sc: SessionContext; turn: string }> = ({ sc, turn }) => {
  const turns = [...sc.growth].reverse(); // oldest first, left to right
  const peak = sc.peak_context_tokens || 1;
  return (
    <div className="ctx-grow">
      <div className="ctx-bars" role="img" aria-label="Context size per turn, oldest to newest">
        {turns.map((t) => (
          <div
            key={t.turn}
            className={`ctx-bar ${t.turn === turn ? 'here' : ''}`}
            style={{ height: `${Math.max(3, Math.round((t.context_tokens / peak) * 100))}%` }}
            title={`${t.turn}: ${formatCount(t.context_tokens)} tokens${t.turn === turn ? ' (this turn)' : ''}`}
          />
        ))}
      </div>
      <div className="strip">
        <div><span>Turns</span><b>{sc.turns}</b></div>
        <div><span>Peak</span><b>{formatCount(sc.peak_context_tokens)}</b></div>
        <div><span>Cache</span><b>{pct(sc.cache_read_tokens, sc.cache_read_tokens + sc.fresh_tokens)}</b></div>
      </div>
    </div>
  );
};

export const ContextView: React.FC<Props> = ({ session, turn, loadTurn, loadSession, rev }) => {
  const [tc, setTc] = useState<TurnContext | undefined>();
  const [sc, setSc] = useState<SessionContext | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  // The tab reads when it opens (and on a new turn/session), and again when the
  // turn's data changes (rev). What it shows is kept until the new read lands.
  // Each read guards its own writes with a per-effect `live` flag (not a shared
  // ref), which React StrictMode's double mount handles — so a stale read can
  // never overwrite a newer one.
  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([loadTurn(session, turn), wholeSession(loadSession, session)])
      .then(([t, s]) => {
        if (!live) return;
        setTc(t);
        setSc(s);
        setError(undefined);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [session, turn, loadTurn, loadSession, rev]);

  if (loading && !tc) return <p className="dim">{LOADING}</p>;
  if (error) return <p className="bad">{error}</p>;
  if (!tc) return <p className="dim">No context for this turn.</p>;

  const cacheTotal = tc.cache_read_tokens + tc.fresh_tokens;
  return (
    <div className="ctx-view">
      {tc.calls === 0 ? (
        <p className="dim">This turn made no model call that reported usage.</p>
      ) : (
        <>
          {tc.window ? (
            <ContextMeter window={tc.window} />
          ) : (
            <div className="tab-sum">
              <b>{formatCount(tc.context_tokens)} tokens</b>
              <span className="sep"> · </span>
              this turn's largest prompt
            </div>
          )}
          <div className="strip">
            {(tc.window?.model || tc.model) && (
              <div><span>Model</span><b><code>{tc.window?.model || tc.model}</code></b></div>
            )}
            <div><span>Calls</span><b>{tc.calls}</b></div>
            <div><span>Output</span><b>{formatCount(tc.output_tokens)}</b></div>
            {cacheTotal > 0 && <div><span>Cache</span><b>{pct(tc.cache_read_tokens, cacheTotal)}</b></div>}
          </div>

          <div className="sub-h">Largest prompt</div>
          <MadeOf ctx={tc} />
        </>
      )}

      <div className="sub-h">Across the session</div>
      {sc ? <Growth sc={sc} turn={turn} /> : <p className="dim">{LOADING}</p>}
    </div>
  );
};
