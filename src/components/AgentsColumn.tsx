import React from 'react';
import { AgentSummary } from '../types';
import { PlusIcon } from './Icons';

interface AgentsColumnProps {
  agents: AgentSummary[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  sourceLabel?: string;
  onDisconnect?: () => void;
  disconnectLabel?: string;
  // Given only when the source keeps saved agents: opens the agents dialog
  // with the "+ Agent" form, or with the list.
  onAddAgent?: () => void;
  onManageAgents?: () => void;
}

export const AgentsColumn: React.FC<AgentsColumnProps> = ({
  agents,
  selectedAgentId,
  onSelectAgent,
  sourceLabel = 'Gateway on this Mac',
  onDisconnect,
  disconnectLabel = 'Disconnect',
  onAddAgent,
  onManageAgents,
}) => {
  return (
    <aside id="agents">
      <header className="colhead">
        <div className="colhead-title">Agents</div>
        {onManageAgents && (
          <button className="manage-agents head-btn" onClick={onManageAgents} aria-label="Saved agents" title="Saved agents">
            Saved
          </button>
        )}
        {onAddAgent && (
          <button className="add-agent head-btn" onClick={onAddAgent} aria-label="Add agent" title="Add agent">
            <PlusIcon />
            Agent
          </button>
        )}
      </header>
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
