import React, { useState } from 'react';
import { callFailed, callGroups } from '../data/turns';
import { CockpitEvent, EventSelection, Level, SessionDetail, Turn, TurnDetail } from '../types';
import {
  formatCost,
  formatDuration,
  formatTime,
  formatTokens,
  stateClass,
  stateLabel,
  toolInputSummary,
} from '../utils/format';
import { Cost } from './Cost';
import { CallPanel, CallTab } from './CallPanel';
import { LoadContext } from './ContextTab';
import { ChevIcon, CopyButton, DownIcon } from './Icons';
import { PanelHead } from './PanelHead';
import { SessionPanel } from './SessionPanel';

interface RightPanelProps {
  turn: Turn | null;
  totalTurns: number;
  // The last click on an event; a new nonce is a new selection, even of the same id.
  selection?: EventSelection | null;
  onSelectEvent?: (eventId: string | null) => void;
  // Which level the panel shows. The turn level when left out.
  level?: Level;
  // The session level's data: the session on screen and its row's cost.
  session?: SessionDetail | null;
  sessionCostUsd?: number | null;
  sessionCostComplete?: boolean;
  agentName?: string;
  // The call level: the model.requested id of the call, in `turn`.
  callId?: string | null;
  onLevel?: (level: Level) => void;
  onSelectTurn?: (turn: Turn) => void;
  onSelectCall?: (turn: Turn, callId: string) => void;
  onOpenEvent?: (turn: Turn, eventId: string) => void;
  // Reads a call's stored request (the call level's Context tab).
  loadContext?: LoadContext;
  // Reads one turn's events, to split a call's replayed history by turn.
  loadTurn?: (sessionId: string, turnId: string) => Promise<TurnDetail | null>;
  // Closes the panel (its ×).
  onClose?: () => void;
  // Esc collapses an open row first, and only the next Esc closes the
  // panel. The turn level puts a function here that collapses its open row
  // and says whether there was one; App calls it before closing the panel.
  escRef?: React.MutableRefObject<(() => boolean) | null>;
}

type TabKey = 'result' | 'events' | 'model' | 'tools' | 'prompt' | 'skills' | 'mcp';

// Follows the selected level: the session, one turn, or one model call. The
// turn and call tabs are kept here, so stepping down and back keeps them.
export const RightPanel: React.FC<RightPanelProps> = (props) => {
  const { level = 'turn', turn, session, callId } = props;
  // Each level opens on its first tab, as in the mockup: Result, and Sent.
  const [turnTab, setTurnTab] = useState<TabKey>('result');
  const [callTab, setCallTab] = useState<CallTab>('sent');
  // The turn panel's open row, for the turn it was opened in. Kept here so a
  // visit to the session or a call does not lose it; another turn starts
  // with its default row.
  const [openRow, setOpenRow] = useState<OpenRow | null>(null);

  if (level === 'session' && session) {
    return (
      <SessionPanel
        session={session}
        costUsd={props.sessionCostUsd}
        costComplete={props.sessionCostComplete}
        agentName={props.agentName ?? session.agent}
        onSelectTurn={(t) => props.onSelectTurn?.(t)}
        onClose={props.onClose}
      />
    );
  }
  const call =
    level === 'call' && turn?.detail ? callGroups(turn.detail).groups.find((g) => g.pair.requested.id === callId) : undefined;
  if (call && turn) {
    return (
      <CallPanel
        turn={turn}
        call={call}
        tab={callTab}
        onTab={setCallTab}
        onLevel={props.onLevel}
        onOpenEvent={props.onOpenEvent}
        loadContext={props.loadContext}
        loadTurn={props.loadTurn}
        turns={session?.turnsList}
        onClose={props.onClose}
      />
    );
  }
  return <TurnPanel {...props} activeTab={turnTab} setActiveTab={setTurnTab} openRow={openRow} setOpenRow={setOpenRow} />;
};

// id null is a row the person collapsed.
interface OpenRow {
  turnId: string;
  id: string | null;
}

interface TurnPanelProps extends RightPanelProps {
  activeTab: TabKey;
  setActiveTab: React.Dispatch<React.SetStateAction<TabKey>>;
  openRow: OpenRow | null;
  setOpenRow: (row: OpenRow | null) => void;
}

// Whether the tab draws the row of eventId (Events draws every event).
function tabShows(tab: TabKey, turn: TurnDetail | undefined, eventId: string): boolean {
  if (!turn) return false;
  if (tab === 'model') {
    return turn.modelCalls.some((p) => p.requested.id === eventId || p.responded?.id === eventId);
  }
  if (tab === 'tools') {
    return turn.toolCalls.some((p) => p.requested.id === eventId || p.completed?.id === eventId);
  }
  return tab === 'events';
}

const TurnPanel: React.FC<TurnPanelProps> = ({
  turn,
  totalTurns,
  selection,
  onSelectEvent,
  onLevel,
  onSelectCall,
  onClose,
  escRef,
  activeTab,
  setActiveTab,
  openRow,
  setOpenRow,
}) => {
  // The open row: what was opened or collapsed in this turn. Rows start
  // collapsed; a click opens one.
  const expandedEventId = turn && openRow?.turnId === turn.id ? openRow.id : null;
  const setExpandedEventId = (id: string | null) => {
    if (turn) setOpenRow({ turnId: turn.id, id });
  };

  // A new selection opens its row. A cleared selection changes nothing, so a
  // row the user collapsed stays collapsed.
  React.useEffect(() => {
    const selectedEventId = selection?.id;
    if (!selectedEventId) return;
    setExpandedEventId(selectedEventId);
    // Keep the tab when it already shows this row (a row opened in Model calls
    // or Tool calls). A selection from elsewhere opens it in Events.
    setActiveTab((tab) => (tabShows(tab, turn?.detail, selectedEventId) ? tab : 'events'));
  }, [selection?.nonce]);

  // Esc collapses the open row before the panel closes (see escRef).
  // Only a row the shown tab draws counts: one opened in Events and left
  // there while Result is shown is not on screen, so Esc closes the panel.
  const openRef = React.useRef<string | null>(null);
  openRef.current =
    expandedEventId !== null && tabShows(activeTab, turn?.detail, expandedEventId)
      ? expandedEventId
      : null;
  const collapseRef = React.useRef<() => void>(() => {});
  collapseRef.current = () => {
    setExpandedEventId(null);
    onSelectEvent?.(null);
  };
  React.useEffect(() => {
    if (!escRef) return;
    const collapse = () => {
      if (openRef.current === null) return false;
      collapseRef.current();
      return true;
    };
    escRef.current = collapse;
    return () => {
      if (escRef.current === collapse) escRef.current = null;
    };
  }, [escRef]);

  if (!turn) {
    return (
      <section id="right">
        <PanelHead up={[]} onClose={onClose}>
          Select a turn
        </PanelHead>
        <div id="d-body">
          <p className="dim">Click a turn in the session column to view its timeline and details.</p>
        </div>
      </section>
    );
  }

  // The turn's own folder, from its turn.started. The session's folder is
  // its latest run's, so it is not offered for an earlier turn.
  const folder = turn.folder;

  // The head reads the turn list's row, so it shows while the events load.
  const head = (
    <>
      <PanelHead up={[{ level: 'session', label: 'Session' }]} onLevel={onLevel} onClose={onClose}>
        {turn.prompt.length > 50 || turn.promptTruncated ? `${turn.prompt.slice(0, 50)}…` : turn.prompt}
        <span className="ch-sub">
          turn {turn.turnNumber} of {totalTurns}
        </span>
      </PanelHead>

      <div id="d-head">
        <div className="strip first">
          <div>
            <span>Cost</span>
            <b>
              <Cost usd={turn.costUsd} complete={turn.costComplete} />
            </b>
          </div>
          <div>
            <span>Tokens</span>
            <b>
              {formatTokens(turn.usage)} in/out
            </b>
          </div>
          <div>
            <span>Time</span>
            <b>{turn.durationMs === undefined ? '—' : formatDuration(turn.durationMs)}</b>
          </div>
          {turn.state !== 'finished' && (
            <div>
              <span>Status</span>
              <b className={`tb-state ${stateClass(turn.state)}`}>{stateLabel(turn)}</b>
            </div>
          )}
          <div>
            <span>Turn</span>
            <b title={turn.id}>
              {turn.id.length > 10 ? `${turn.id.slice(0, 10)}…` : turn.id}
              <CopyButton text={turn.id} />
            </b>
          </div>
          {/* The folder the turn ran in, cut with an ellipsis; the full path is its tooltip. */}
          {folder && (
            <div className="fold">
              <span>Folder</span>
              <b title={folder}>{folder}</b>
            </div>
          )}
        </div>
      </div>

    </>
  );

  const detail = turn.detail;
  if (!detail) {
    return (
      <section id="right">
        {head}
        <div id="d-body">
          <p className="dim">Loading the turn's events…</p>
        </div>
      </section>
    );
  }

  // `isOpen` is the row's own computed state: a ledger row can be open through
  // its request or through its reply or result.
  const toggleEventDetail = (eventId: string, isOpen = expandedEventId === eventId) => {
    const next = isOpen ? null : eventId;
    setExpandedEventId(next);
    onSelectEvent?.(next);
  };

  const renderEventSummary = (e: CockpitEvent) => {
    switch (e.kind) {
      case 'turn.started':
        return <span>turn started</span>;
      case 'model.requested':
        return (
          <span>
            {e.model || 'model'} · tools offered: {e.tools_offered?.length || 0}
          </span>
        );
      case 'model.responded':
        return (
          <span>
            {callFailed(e) && <span className="bad">failed · </span>}
            <code>{e.stop_reason || 'stop'}</code>
            {e.usage?.output_tokens ? ` · ${e.usage.output_tokens} out` : ''}
          </span>
        );
      case 'tool.requested':
        return (
          <span>
            <code>{e.tool_name}</code> {toolInputSummary(e.tool_input).slice(0, 80)}
          </span>
        );
      case 'tool.completed':
        return (
          <span>
            {e.tool_error ? <span className="bad">error</span> : <span className="ok">completed</span>}
            {' · '}
            {(e.tool_output || '').slice(0, 80).replace(/\n/g, ' ')}
          </span>
        );
      case 'turn.completed':
        return (
          <span>
            outcome: <span className="ok">{e.outcome || 'finished'}</span>
          </span>
        );
      default:
        return <span>{e.kind}</span>;
    }
  };

  const renderEventDuration = (e: CockpitEvent) => {
    if (e.kind === 'model.responded' && e.latency_ms) {
      return `${e.latency_ms}ms`;
    }
    return '';
  };

  // With merge (the Events tab, one row per event), a request shows its paired
  // reply's figures and a reply its request's. Without it (the Model and Tool
  // calls tabs, which show Request and Reply blocks together), each event shows
  // only its own fields, so nothing appears twice.
  const renderEventExpandedDetail = (e: CockpitEvent, merge = true) => {
    // Look up paired events if available
    let modelName = e.model;
    let stopReason = e.stop_reason;
    let usage = e.usage;
    let latency = e.latency_ms;
    let responseText = e.text;
    let toolName = e.tool_name;
    let toolId = e.tool_id;
    let toolInput = e.tool_input;
    let toolOutput = e.tool_output;
    let toolsOffered = e.tools_offered;
    let cost = e.cost_usd;
    let costComplete = e.cost_complete === true;
    // A reply's error shows whatever its status; a request shows its reply's.
    let reply: CockpitEvent | undefined = e.kind === 'model.responded' ? e : undefined;

    if (!merge) {
      // Each event's own fields only.
    } else if (e.kind === 'model.requested' || e.kind === 'model.responded') {
      const pair = detail.modelCalls.find((p) => p.requested === e || p.responded === e);
      if (e.kind === 'model.requested' && pair?.responded) {
        stopReason = pair.responded.stop_reason;
        usage = pair.responded.usage;
        latency = pair.responded.latency_ms;
        responseText = pair.responded.text;
        cost = pair.responded.cost_usd;
        costComplete = pair.responded.cost_complete === true;
        reply = pair.responded;
      } else if (e.kind === 'model.responded' && pair) {
        modelName = pair.requested.model;
        toolsOffered = pair.requested.tools_offered;
      }
    } else if (e.kind === 'tool.requested' || e.kind === 'tool.completed') {
      // A result is matched to its call by tool_id (in the turn's tool calls).
      const pair = detail.toolCalls.find((p) => p.requested === e || p.completed === e);
      if (e.kind === 'tool.requested' && pair?.completed) {
        toolOutput = pair.completed.tool_output;
      } else if (e.kind === 'tool.completed' && pair) {
        toolName = pair.requested.tool_name;
        toolInput = pair.requested.tool_input;
      }
    }

    return (
      <div className="det">
        <div className="kvs">
          <span>Event ID</span>
          <span><code>{e.id}</code></span>

          <span>Time</span>
          <span><code>{e.time}</code></span>

          {modelName ? (
            <>
              <span>Model</span>
              <span><code>{modelName}</code></span>
            </>
          ) : null}

          {callFailed(reply) ? (
            <>
              <span>Status</span>
              <span className="bad">
                failed{reply!.status !== undefined ? ` · ${reply!.status}` : ''}
              </span>
              {reply!.error ? (
                <>
                  <span>Error</span>
                  <span className="bad">{typeof reply!.error === 'string' ? reply!.error : JSON.stringify(reply!.error)}</span>
                </>
              ) : null}
            </>
          ) : null}

          {stopReason ? (
            <>
              <span>Stop reason</span>
              <span><code>{stopReason}</code></span>
            </>
          ) : null}

          {usage ? (
            <>
              <span>Tokens</span>
              <span>
                {usage.input_tokens} in / {usage.output_tokens} out
                {usage.cache_read_tokens ? ` · ${usage.cache_read_tokens} cache read` : ''}
                {usage.cache_write_tokens ? ` · ${usage.cache_write_tokens} cache write` : ''}
              </span>
            </>
          ) : null}

          {latency ? (
            <>
              <span>Latency</span>
              <span>{latency}ms</span>
            </>
          ) : null}

          {formatCost(cost) ? (
            <>
              <span>Cost</span>
              <span>
                <Cost usd={cost} complete={costComplete} />
              </span>
            </>
          ) : null}

          {toolName ? (
            <>
              <span>Tool</span>
              <span><code>{toolName}</code></span>
            </>
          ) : null}

          {toolId ? (
            <>
              <span>Tool ID</span>
              <span><code>{toolId}</code></span>
            </>
          ) : null}

          {toolsOffered ? (
            <>
              <span>Tools offered</span>
              <span>{toolsOffered.join(', ')}</span>
            </>
          ) : null}
        </div>

        {toolInput !== undefined && (
          <div style={{ marginTop: '0.5rem' }}>
            <div className="sub-h">Tool Input</div>
            <pre className="term">
              {typeof toolInput === 'string'
                ? toolInput
                : JSON.stringify(toolInput, null, 2)}
            </pre>
          </div>
        )}

        {toolOutput !== undefined && (
          <div style={{ marginTop: '0.5rem' }}>
            <div className="sub-h">Tool Output</div>
            <pre className="term">{toolOutput}</pre>
          </div>
        )}

        {responseText !== undefined && responseText !== '' && (
          <div style={{ marginTop: '0.5rem' }}>
            <div className="sub-h">Response Text</div>
            <pre className="term">{responseText}</pre>
          </div>
        )}
      </div>
    );
  };

  return (
    <section id="right">
      {head}

      <div id="d-tabs">
        {TURN_TABS.map(([key, label]) => (
          <button key={key} className={`tab ${activeTab === key ? 'on' : ''}`} onClick={() => setActiveTab(key)}>
            {label}
          </button>
        ))}
      </div>

      <div id="d-body">
        <TabSum tab={activeTab} turn={turn} detail={detail} />

        {activeTab === 'result' && (
          <div>
            {detail.agentResponse ? (
              <div className="reply">
                {detail.agentResponse.split('\n\n').map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            ) : (
              <p className="dim">No final answer yet.</p>
            )}
          </div>
        )}

        {activeTab === 'events' && (
          <table className="grid events">
            <thead>
              <tr>
                <th style={{ width: '1.25rem' }}></th>
                <th>Time</th>
                <th>Event</th>
                <th>Detail</th>
                <th className="r">Took</th>
              </tr>
            </thead>
            <tbody>
              {detail.events.map((e) => {
                const isOpen = expandedEventId === e.id;
                const isDenied = e.tool_error;
                return (
                  <React.Fragment key={e.id}>
                    <tr
                      className={`ev ${isOpen ? 'sel' : ''} ${isDenied ? 'denied' : ''}`}
                      onClick={() => toggleEventDetail(e.id)}
                    >
                      <td className="c">{isOpen ? <DownIcon /> : <ChevIcon />}</td>
                      <td className="t">{formatTime(e.time)}</td>
                      <td>
                        <code className="ty">{e.kind}</code>
                      </td>
                      <td className="sm">{renderEventSummary(e)}</td>
                      <td className="r">{renderEventDuration(e)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="ev-open">
                        <td></td>
                        <td colSpan={4}>{renderEventExpandedDetail(e)}</td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}

        {activeTab === 'model' && (
          <div>
            <table className="grid events">
              <thead>
                <tr>
                  <th style={{ width: '1.25rem' }}></th>
                  <th>#</th>
                  <th className="r">In</th>
                  <th className="r">Cache</th>
                  <th className="r">Out</th>
                  <th>Stop Reason</th>
                  <th className="r">Latency</th>
                  <th className="r">Cost</th>
                </tr>
              </thead>
              <tbody>
                {detail.modelCalls.map((pair, idx) => {
                  const req = pair.requested;
                  const res = pair.responded;
                  const isOpen = expandedEventId === req.id || expandedEventId === res?.id;
                  return (
                    <React.Fragment key={req.id}>
                      <tr
                        className={`ev ${isOpen ? 'sel' : ''}`}
                        onClick={() => toggleEventDetail(req.id, isOpen)}
                      >
                        <td className="c">{isOpen ? <DownIcon /> : <ChevIcon />}</td>
                        <td>{idx + 1}</td>
                        <td className="r">{res?.usage?.input_tokens ?? 0}</td>
                        <td className="r">{res?.usage?.cache_read_tokens ?? 0}</td>
                        <td className="r">{res?.usage?.output_tokens ?? 0}</td>
                        <td>
                          {callFailed(res) && <span className="bad">failed </span>}
                          <code>{res?.stop_reason || (callFailed(res) ? '' : '—')}</code>
                        </td>
                        <td className="r">{res?.latency_ms ? `${res.latency_ms}ms` : '—'}</td>
                        <td className="r">
                          <Cost usd={res?.cost_usd} complete={res?.cost_complete === true} />
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="ev-open">
                          <td></td>
                          <td colSpan={7}>
                            {onSelectCall && (
                              <button className="open-call" onClick={() => onSelectCall(turn, req.id)}>
                                Open call {idx + 1}
                              </button>
                            )}
                            <div className="sub-h">Request</div>
                            {renderEventExpandedDetail(req, false)}
                            {res && (
                              <>
                                <div className="sub-h" style={{ marginTop: '0.75rem' }}>
                                  Reply
                                </div>
                                {renderEventExpandedDetail(res, false)}
                              </>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'tools' && (
          <div>
            <table className="grid events">
              <thead>
                <tr>
                  <th style={{ width: '1.25rem' }}></th>
                  <th>Time</th>
                  <th>Tool</th>
                  <th>Input</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {detail.toolCalls.map((pair) => {
                  const req = pair.requested;
                  const comp = pair.completed;
                  const isOpen = expandedEventId === req.id || expandedEventId === comp?.id;
                  return (
                    <React.Fragment key={req.id}>
                      <tr
                        className={`ev ${isOpen ? 'sel' : ''}`}
                        onClick={() => toggleEventDetail(req.id, isOpen)}
                      >
                        <td className="c">{isOpen ? <DownIcon /> : <ChevIcon />}</td>
                        <td className="t">{formatTime(req.time)}</td>
                        <td>
                          <code>{req.tool_name}</code>
                        </td>
                        <td className="sm">
                          <code>{toolInputSummary(req.tool_input).slice(0, 60)}</code>
                        </td>
                        <td>
                          {comp?.tool_error ? (
                            <span className="bad">error</span>
                          ) : comp ? (
                            <span className="ok">ok</span>
                          ) : (
                            <span className="dim">pending</span>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="ev-open">
                          <td></td>
                          <td colSpan={4}>
                            <div className="sub-h">Tool Request</div>
                            {renderEventExpandedDetail(req, false)}
                            {comp && (
                              <>
                                <div className="sub-h" style={{ marginTop: '0.75rem' }}>
                                  Tool Result
                                </div>
                                {renderEventExpandedDetail(comp, false)}
                              </>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}


        {activeTab === 'prompt' && (
          <div>
            <textarea
              className="prompt"
              readOnly
              rows={6}
              style={{ width: '100%', marginBottom: '0.75rem', padding: '0.625rem' }}
              value={detail.prompt ?? turn.prompt}
            />

            {detail.rawPrompt !== undefined && detail.rawPrompt !== detail.prompt && (
              <>
                <div className="sub-h">Full Raw Prompt (with System Reminders)</div>
                <pre className="term" style={{ maxHeight: '18.75rem', overflowY: 'auto' }}>
                  {detail.rawPrompt}
                </pre>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
};

// The distinct models the turn's calls asked for (model.requested `model`), in
// first-use order.
export function turnModels(turn: TurnDetail): string[] {
  const seen: string[] = [];
  for (const p of turn.modelCalls) {
    const m = p.requested.model;
    if (typeof m === 'string' && m && !seen.includes(m)) seen.push(m);
  }
  return seen;
}

// The turn tabs, in the mockup's order. Reasoning and CI/CD are not here:
// the API has no data for them yet.
const TURN_TABS: [TabKey, string][] = [
  ['result', 'Result'],
  ['prompt', 'Prompt'],
  ['events', 'Events'],
  ['model', 'Model calls'],
  ['tools', 'Tools'],
  ['skills', 'Skills'],
  ['mcp', 'MCP'],
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Every turn tab opens with one summary line in one style: a count or a
// state in bold, then plain facts. Skills and MCP say what they will show:
// the API does not offer that data yet.
export const TabSum: React.FC<{ tab: TabKey; turn: Turn; detail: TurnDetail }> = ({ tab, turn, detail }) => {
  const facts: React.ReactNode[] = [];
  let head: React.ReactNode;
  switch (tab) {
    case 'result': {
      head = <span className={stateClass(turn.state)}>{stateLabel(turn)}</span>;
      facts.push(plural(detail.modelCalls.length, 'model call'), plural(detail.toolCalls.length, 'tool call'));
      break;
    }
    case 'prompt': {
      const text = (detail.prompt ?? turn.prompt).trim();
      head = plural(text === '' ? 0 : text.split(/\s+/).length, 'word');
      break;
    }
    case 'events':
      head = plural(detail.events.length, 'event');
      facts.push('click a row to open it');
      break;
    case 'model': {
      head = plural(detail.modelCalls.length, 'call');
      const models = turnModels(detail);
      if (models.length) facts.push(models.join(', '));
      facts.push('click a call to open it');
      break;
    }
    case 'tools': {
      head = plural(detail.toolCalls.length, 'tool call');
      const failed = detail.toolCalls.filter((p) => p.completed?.tool_error).length;
      if (failed) facts.push(<span className="bad">{failed} failed</span>);
      facts.push('click a row to open it');
      break;
    }
    case 'skills':
      head = 'Coming next';
      facts.push('the skills this agent can use, and which ones this turn loaded');
      break;
    case 'mcp':
      head = 'Coming next';
      facts.push('the MCP servers this agent connects to, and the calls this turn made to each');
      break;
  }
  return (
    <div className="tab-sum">
      <b>{head}</b>
      {facts.map((f, i) => (
        <React.Fragment key={i}>
          <span className="sep"> · </span>
          {f}
        </React.Fragment>
      ))}
    </div>
  );
};
