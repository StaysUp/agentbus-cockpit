import React from 'react';
import { Level } from '../types';

// The right panel's header: the levels above the shown one as quiet links,
// then the shown level's own title. "Session › Turn 1 › Call 2 of 7".
export const PanelHead: React.FC<{
  up: { level: Level; label: string }[];
  onLevel?: (level: Level) => void;
  children: React.ReactNode;
}> = ({ up, onLevel, children }) => (
  <header id="p-head" className="colhead">
    <div className="colhead-title">
      {up.map((u) => (
        <React.Fragment key={u.level}>
          <button className="crumb" data-level={u.level} onClick={() => onLevel?.(u.level)}>
            {u.label}
          </button>
          <span className="crumb-sep">›</span>
        </React.Fragment>
      ))}
      {children}
    </div>
  </header>
);
