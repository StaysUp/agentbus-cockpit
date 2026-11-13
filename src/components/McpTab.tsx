import React from 'react';
import { Toolbox, ToolboxTool, toolState } from '../data/toolbox';

interface McpTabProps {
  box: Toolbox | null;
  running: boolean;
}

// The turn's toolbox by source: AgentBus tools with each one's state, the
// harness's own tools AgentBus hid, and any other tool server in the record.
export const McpTab: React.FC<McpTabProps> = ({ box, running }) => {
  if (!box) {
    return (
      <p className="empty mcp-off">
        {running ? 'No tool list served to this turn yet.' : 'AgentBus tools are off for this turn ([agent_api] tools).'}
      </p>
    );
  }
  return (
    <div className="mcp">
      <div className="sub-h">AgentBus tools</div>
      {!box.listed && (
        <p className="dim mcp-note">This turn has no tools.listed in the record: these are the tools its calls show.</p>
      )}
      {box.agentbus.length ? <Tools tools={box.agentbus} server={box.server} /> : <p className="dim">None served.</p>}

      <div className="sub-h">Hidden by AgentBus</div>
      {box.hidden.length ? (
        <div className="grid-scroll">
        <table className="grid mcp-t">
          <tbody>
            {box.hidden.map((h) => (
              <tr key={h.name}>
                <td>
                  <code>{h.name}</code>
                </td>
                <td className="dim">{h.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : (
        <p className="dim">{box.listed ? 'None: this harness keeps all its own tools.' : 'Not in the record.'}</p>
      )}

      {box.other.map((s) => (
        <React.Fragment key={s.server}>
          <div className="sub-h">Other tool server: {s.server}</div>
          <Tools tools={s.tools} server={s.server} />
        </React.Fragment>
      ))}
    </div>
  );
};

const Tools: React.FC<{ tools: ToolboxTool[]; server: string }> = ({ tools, server }) => (
  <div className="grid-scroll">
  <table className="grid mcp-t">
    <tbody>
      {tools.map((t) => (
        <tr key={t.name}>
          <td title={`mcp__${server}__${t.name}`}>
            <code>{t.name}</code>
          </td>
          <td className={t.uses > 0 ? 'ok' : 'dim'}>{toolState(t)}</td>
        </tr>
      ))}
    </tbody>
  </table>
  </div>
);
