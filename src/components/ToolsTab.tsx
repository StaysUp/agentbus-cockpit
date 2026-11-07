import React from 'react';
import { formatElapsed, ToolCard, ToolGroup, toolGroups } from '../data/liveStatus';
import { CockpitEvent, ModelCallPair, TurnDetail } from '../types';
import { formatCost } from '../utils/format';

// An Edit shows at most this many diff lines, a Write this many of its new
// file, a script this many of its lines; the rest is counted.
const DIFF_LINES = 8;
const WRITE_LINES = 4;
const SCRIPT_LINES = 8;

interface ToolsTabProps {
  detail: TurnDetail;
  folder?: string;
  // On the events' clock; read while the turn runs.
  now: number;
  // False once the turn has ended: a tool with no result then has none.
  running: boolean;
  openId: string | null;
  onToggle: (eventId: string, isOpen: boolean) => void;
  renderDetail: (e: CockpitEvent) => React.ReactNode;
}

// One card per tool, under a thin line per model call that asked for tools.
// The tools of one reply share one time: their results come back together.
export const ToolsTab: React.FC<ToolsTabProps> = ({ detail, folder, now, running, openId, onToggle, renderDetail }) => {
  const groups = toolGroups(detail, folder);
  const calls = detail.modelCalls.filter((p) => !p.requested.probe);
  return (
    <div className="tcards">
      {groups.map((g) => (
        <div className="tgroup" key={g.tools[0].pair.requested.id}>
          <CallLine group={g} pair={g.call ? calls[g.call - 1] : undefined} />
          {g.tools.map((card) => (
            <Card
              key={card.pair.requested.id}
              card={card}
              grouped={g.tools.length > 1}
              now={now}
              running={running}
              isOpen={openId === card.pair.requested.id || (!!card.pair.completed && openId === card.pair.completed.id)}
              onToggle={onToggle}
              renderDetail={renderDetail}
            />
          ))}
          {g.tools.length > 1 && (
            <div className="tgroup-t">
              {g.tools.length} tools from {g.call ? `call ${g.call}` : 'one reply'} ·{' '}
              {g.endedMs !== undefined
                ? formatElapsed(g.endedMs - g.startedMs)
                : running
                  ? `${formatElapsed(now - g.startedMs)} · they finish together`
                  : 'they finish together'}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

// "call 2 · 352 out · $0.04 · 5.2s", then the words the agent put beside its tools.
const CallLine: React.FC<{ group: ToolGroup; pair?: ModelCallPair }> = ({ group, pair }) => {
  const res = pair?.responded;
  const facts: string[] = [group.call ? `call ${group.call}` : 'call'];
  if (res?.usage?.output_tokens) facts.push(`${res.usage.output_tokens} out`);
  const c = formatCost(res?.cost_usd as number | undefined, res?.cost_complete === true);
  if (c) facts.push(c);
  if (res?.latency_ms) facts.push(`${(res.latency_ms / 1000).toFixed(1)}s`);
  const said = typeof res?.text === 'string' ? res.text.trim() : '';
  return (
    <>
      <div className="tcall">{facts.join(' · ')}</div>
      {said && <div className="tsaid">{said}</div>}
    </>
  );
};

interface CardProps {
  card: ToolCard;
  grouped: boolean;
  now: number;
  running: boolean;
  isOpen: boolean;
  onToggle: (eventId: string, isOpen: boolean) => void;
  renderDetail: (e: CockpitEvent) => React.ReactNode;
}

const Card: React.FC<CardProps> = ({ card, grouped, now, running, isOpen, onToggle, renderDetail }) => {
  const r = card.result;
  const open = !r && running;
  const cls = ['tcard', open ? 'running' : '', r?.failed ? 'failed' : '', isOpen ? 'sel' : ''].filter(Boolean).join(' ');
  // A tool alone has its own time; tools of one reply show it once, on the group.
  const took = !grouped && card.endedMs !== undefined ? ` · ${formatElapsed(card.endedMs - card.startedMs)}` : '';
  const right = r ? (
    <span className={`d${r.failed ? ' bad' : ''}`}>{r.text + took}</span>
  ) : open ? (
    <span className="d run">
      <i className="spin run-spin" aria-hidden />
      {grouped ? '' : formatElapsed(now - card.startedMs)}
    </span>
  ) : (
    <span className="d dim">no result</span>
  );
  return (
    <div className={cls} data-tool={card.pair.requested.tool_name}>
      <div className="tcard-h" onClick={() => onToggle(card.pair.requested.id, isOpen)}>
        <span className="k">{card.label}</span>
        <span className="t">{card.target ? <code>{card.target}</code> : null}</span>
        {right}
      </div>
      {card.diff && <Diff del={card.diff.del} add={card.diff.add} />}
      {card.write && <WriteLines lines={card.write} />}
      {card.script && <Script text={card.script} />}
      {r?.failed && r.why && <div className="why">{r.why}</div>}
      {isOpen && (
        <div className="tcard-open">
          <div className="sub-h">Tool Request</div>
          {renderDetail(card.pair.requested)}
          {card.pair.completed && (
            <>
              <div className="sub-h" style={{ marginTop: '0.75rem' }}>
                Tool Result
              </div>
              {renderDetail(card.pair.completed)}
            </>
          )}
        </div>
      )}
    </div>
  );
};

const Diff: React.FC<{ del: string[]; add: string[] }> = ({ del, add }) => {
  const rows = [...del.map((l) => ['del', `- ${l}`]), ...add.map((l) => ['add', `+ ${l}`])];
  const shown = rows.slice(0, DIFF_LINES);
  const more = rows.length - shown.length;
  return (
    <div className="tdiff">
      {shown.map(([k, l], i) => (
        <div key={i} className={k}>
          {l}
        </div>
      ))}
      {more > 0 && <div className="more">{more} more {more === 1 ? 'line' : 'lines'}</div>}
    </div>
  );
};

const WriteLines: React.FC<{ lines: string[] }> = ({ lines }) => (
  <div className="tdiff">
    {lines.slice(0, WRITE_LINES).map((l, i) => (
      <div key={i} className="add">
        + {l}
      </div>
    ))}
    <div className="more">
      new file · {lines.length} {lines.length === 1 ? 'line' : 'lines'}
    </div>
  </div>
);

const Script: React.FC<{ text: string }> = ({ text }) => {
  const lines = text.replace(/\n$/, '').split('\n');
  const more = lines.length - SCRIPT_LINES;
  return (
    <pre className="tscript">
      {lines.slice(0, SCRIPT_LINES).join('\n')}
      {more > 0 ? `\n${more} more ${more === 1 ? 'line' : 'lines'}` : ''}
    </pre>
  );
};
