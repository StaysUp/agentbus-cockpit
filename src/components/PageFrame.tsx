import React from 'react';
import { ColumnFoot } from './ColumnFoot';
import type { Page } from '../page';

interface PageFrameProps {
  title: string;
  // current is the page this frame is, so the foot nav leaves its row out.
  // onBack is the Cockpit row, the way back. onRunners and onSettings open the
  // sibling pages, absent when the source does not have them. The rest feed the
  // shared foot (ColumnFoot): the Runners count, the Feedback box, and the
  // AgentBus card (build, live dot, address, Disconnect).
  current: Page;
  // subtitle is a small, muted note just above the column foot, such as when the settings
  // last changed.
  subtitle?: React.ReactNode;
  onBack: () => void;
  onGuide?: () => void;
  onApps?: () => void;
  onRunners?: () => void;
  onSettings?: () => void;
  runnersOnline?: number;
  version?: string;
  sourceLabel?: string;
  streamUp?: boolean;
  onDisconnect?: () => void;
  disconnectLabel?: string;
  // The left column holds only the list to pick from; the foot is the shared
  // ColumnFoot, the same as the cockpit's.
  list: React.ReactNode;
  // The middle column (what was picked) and the right one (its detail).
  main: React.ReactNode;
  side: React.ReactNode;
}

// PageFrame is a page of its own beside the cockpit, in the mockup's three
// columns: a list with the page's title, then what was picked, then its detail.
// Each column scrolls on its own. The foot is ColumnFoot, identical to the
// cockpit's; its Cockpit row is the way back.
export const PageFrame: React.FC<PageFrameProps> = ({
  title,
  current,
  subtitle,
  onBack,
  onGuide,
  onApps,
  onRunners,
  onSettings,
  runnersOnline,
  version,
  sourceLabel,
  streamUp,
  onDisconnect,
  disconnectLabel,
  list,
  main,
  side,
}) => (
  <div id="page" className="page" aria-label={title}>
    <aside className="pg-list">
      <header className="colhead">
        <h1 className="colhead-title">{title}</h1>
      </header>
      <div className="colbody">{list}</div>
      {subtitle && <p className="pg-foot-note">{subtitle}</p>}
      <ColumnFoot
        current={current}
        onCockpit={onBack}
        onGuide={onGuide}
        onApps={onApps}
        onRunners={onRunners}
        onSettings={onSettings}
        runnersOnline={runnersOnline}
        version={version}
        sourceLabel={sourceLabel}
        streamUp={streamUp}
        onDisconnect={onDisconnect}
        disconnectLabel={disconnectLabel}
      />
    </aside>
    <main className="pg-main">{main}</main>
    <section className="pg-side">{side}</section>
  </div>
);

// ColHead is a column's 72px header row: a title, a quiet note after it, and
// an action on the right.
export const ColHead: React.FC<{ title: React.ReactNode; sub?: React.ReactNode; action?: React.ReactNode }> = ({
  title,
  sub,
  action,
}) => (
  <header className="colhead">
    <div className="colhead-title">
      {title}
      {sub && <span className="ch-sub">{sub}</span>}
    </div>
    {action}
  </header>
);

