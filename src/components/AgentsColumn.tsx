import React, { useState } from 'react';
import { follow, PAGE_PATHS } from '../page';
import { AgentSummary } from '../types';
import { PlusIcon } from './Icons';

interface AgentsColumnProps {
  agents: AgentSummary[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  sourceLabel?: string;
  onDisconnect?: () => void;
  disconnectLabel?: string;
  // Given only when the source keeps saved agents: "+ Agent" opens the form,
  // and a saved agent's row can be edited and removed. A remove answers
  // with the API's words when it is refused.
  onAddAgent?: () => void;
  onEditAgent?: (agent: AgentSummary) => void;
  onRemoveAgent?: (agentId: string) => Promise<void>;
  // Given only when the source lists runners (GET /api/v0/runners): opens
  // the Runners page. runnersOnline is how many are online; undefined
  // before the first read.
  onRunners?: () => void;
  runnersOnline?: number;
  // Given only when the source keeps settings: opens the Settings page.
  onSettings?: () => void;
  // The service's build, from GET /api/v0/version, shown on the AgentBus card.
  version?: string;
}

// The Agents column: every saved agent, even one with no session yet, with
// its access and how many sessions started on it. Selecting one marks it for
// "+ Session"; the Sessions column lists every session either way. Sessions
// no saved agent started are counted under their harness, after the saved
// agents.
export const AgentsColumn: React.FC<AgentsColumnProps> = ({
  agents,
  selectedAgentId,
  onSelectAgent,
  sourceLabel = 'Gateway on this Mac',
  onDisconnect,
  disconnectLabel = 'Disconnect',
  onAddAgent,
  onEditAgent,
  onRemoveAgent,
  onRunners,
  runnersOnline,
  onSettings,
  version,
}) => {
  // The row asking "Remove?", and a remove in flight or refused.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ id: string; msg: string } | null>(null);

  const remove = async (id: string) => {
    if (!onRemoveAgent) return;
    setBusy(true);
    setError(null);
    try {
      await onRemoveAgent(id);
      setConfirming(null);
    } catch (err) {
      setError({ id, msg: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside id="agents">
      <header className="colhead">
        <div className="colhead-title">Agents</div>
        {onAddAgent && (
          <button className="add-agent head-btn" onClick={onAddAgent} aria-label="Add agent" title="Add agent">
            <PlusIcon />
            Agent
          </button>
        )}
      </header>
      <div className="colbody">
        {agents.length === 0 && <p className="dim agents-empty">No agents yet.</p>}
        {agents.map((a) => {
          const isSelected = selectedAgentId === a.id;
          const count = `${a.sessionCount} ${a.sessionCount === 1 ? 'session' : 'sessions'}`;
          const body = (
            <>
              <span className={`mark ${a.saved?.harness ?? a.id}`}>{a.mark}</span>
              <span className="ag-t">
                <b>{a.name}</b>
                <span>
                  {count}
                  {a.openCount > 0 ? ` · ${a.openCount} running` : ''}
                </span>
                {a.line && <span className="q-l">{a.line}</span>}
              </span>
            </>
          );
          const canChange = !!a.saved && (onEditAgent || onRemoveAgent);
          // The selected saved agent's row carries Edit and Remove, so it is
          // not a button itself.
          if (isSelected && canChange) {
            return (
              <div key={a.id} className="side-chat agent on" data-agent={a.id}>
                {body}
                <span className="ag-act">
                  {confirming === a.id ? (
                    <>
                      <span>Remove?</span>
                      <button type="button" className="ag-yes" disabled={busy} onClick={() => remove(a.id)}>
                        Remove
                      </button>
                      <button type="button" className="ag-keep" disabled={busy} onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <>
                      {onEditAgent && (
                        <button type="button" className="ag-edit" onClick={() => onEditAgent(a)}>
                          Edit
                        </button>
                      )}
                      {onRemoveAgent && (
                        <button
                          type="button"
                          className="ag-remove"
                          onClick={() => {
                            setError(null);
                            setConfirming(a.id);
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </>
                  )}
                </span>
                {error?.id === a.id && <span className="form-error">{error.msg}</span>}
              </div>
            );
          }
          return (
            <button
              key={a.id}
              className={`side-chat agent ${isSelected ? 'on' : ''}`}
              data-agent={a.id}
              onClick={() => {
                setConfirming(null);
                setError(null);
                onSelectAgent(a.id);
              }}
            >
              {body}
            </button>
          );
        })}
      </div>

      {/* The foot stays put while the list above it scrolls: the links to
          the cockpit's own pages, then the AgentBus this cockpit reads, as one
          card: its name, its build, a live dot and where the data comes from. */}
      <div className="brand-foot">
        {/* Quiet links to the cockpit's own pages, each at its address. */}
        {(onRunners || onSettings) && (
          <nav className="side-links" aria-label="Pages">
            {onRunners && (
              <a className="side-link" href={PAGE_PATHS.runners} onClick={follow(onRunners)}>
                <span>Runners</span>
                {runnersOnline !== undefined && (
                  <span className="sl-n" title="online">
                    {runnersOnline}
                  </span>
                )}
              </a>
            )}
            {onSettings && (
              <a className="side-link" href={PAGE_PATHS.settings} onClick={follow(onSettings)}>
                <span>Settings</span>
              </a>
            )}
          </nav>
        )}
        <div className="bus-card">
          <span className="bc-t">
            <b className="brand">
              AgentBus
              {version && " "}
              {version && (
                <span className="bc-v" title="this service's build">
                  {version}
                </span>
              )}
            </b>
            <span className="bc-a gw">
              <i className="live" />
              <span>{sourceLabel}</span>
            </span>
          </span>
          {onDisconnect && (
            <button className="disconnect" onClick={onDisconnect}>
              {disconnectLabel}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
};
