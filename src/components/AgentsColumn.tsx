import React, { useState } from 'react';
import { AgentSummary, InstalledAgent } from '../types';
import { PlusIcon } from './Icons';

interface AgentsColumnProps {
  agents: AgentSummary[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  sourceLabel?: string;
  onDisconnect?: () => void;
  disconnectLabel?: string;
  // Given only when the source can list and start agents.
  loadAgents?: () => Promise<InstalledAgent[]>;
  onStartWith?: (agent: string) => void;
}

export const AgentsColumn: React.FC<AgentsColumnProps> = ({
  agents,
  selectedAgentId,
  onSelectAgent,
  sourceLabel = 'Gateway on this Mac',
  onDisconnect,
  disconnectLabel = 'Disconnect',
  loadAgents,
  onStartWith,
}) => {
  // The list from GET /api/v0/agents while it is open; null when closed.
  const [list, setList] = useState<{ agents?: InstalledAgent[]; error?: string } | null>(null);
  const toggleList = () => {
    if (list || !loadAgents) {
      setList(null);
      return;
    }
    setList({});
    loadAgents().then(
      (agents) => setList((cur) => cur && { agents }),
      (err: Error) => setList((cur) => cur && { error: err.message })
    );
  };

  return (
    <aside id="agents">
      <header className="colhead">
        <div className="colhead-title">Agents</div>
        {loadAgents && (
          <button className="add-agent head-btn" onClick={toggleList} aria-expanded={list !== null} aria-label="Add agent" title="Add agent">
            <PlusIcon />
            Agent
          </button>
        )}
      </header>
      {list && (
        <ul className="agent-list">
          {!list.agents && !list.error && <li className="dim">Looking…</li>}
          {list.error && <li className="bad">{list.error}</li>}
          {list.agents?.length === 0 && <li className="dim">The service found no agents.</li>}
          {list.agents?.map((a) =>
            a.found ? (
              <li key={a.name}>
                <button
                  onClick={() => {
                    setList(null);
                    onStartWith?.(a.name);
                  }}
                >
                  <b>{a.name}</b>
                  <span>
                    {a.version ?? 'version unknown'}
                    {a.signed_in === true && <> · <span className="ok">signed in</span></>}
                    {a.signed_in === false && <> · <span className="warn">not signed in</span></>}
                  </span>
                </button>
              </li>
            ) : (
              <li key={a.name} className="off">
                <b>{a.name}</b>
                <span>not installed</span>
              </li>
            )
          )}
        </ul>
      )}
      <div className="colbody">
        {agents.map((a) => {
          const isSelected = selectedAgentId === a.id;
          return (
            <button
              key={a.id}
              className={`side-chat agent ${isSelected ? 'on' : ''}`}
              onClick={() => onSelectAgent(a.id)}
            >
              <span className={`mark ${a.id}`}>{a.mark}</span>
              <span className="ag-t">
                <b>{a.name}</b>
                <span>
                  {a.sessionCount} {a.sessionCount === 1 ? 'session' : 'sessions'}
                </span>
              </span>
            </button>
          );
        })}

        {/* The AgentBus this cockpit reads, as one card at the foot: its name, a
            live dot and where the data comes from. */}
        <div className="brand-foot">
          <div className="bus-card">
            <span className="bc-t">
              <b className="brand">AgentBus</b>
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
      </div>
    </aside>
  );
};
