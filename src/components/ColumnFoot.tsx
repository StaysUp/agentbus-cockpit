import React from 'react';
import { Button } from './Controls';
import { PRODUCT } from '../words';
import { FootNav } from './FootNav';
import type { Page } from '../page';

interface ColumnFootProps {
  // The page on screen; its nav row is shown as the current one.
  current: Page;
  // The nav targets: the cockpit (the way back from a page) and the sibling
  // pages, each absent when the source does not have it.
  onCockpit?: () => void;
  onApps?: () => void;
  onRunners?: () => void;
  onSettings?: () => void;
  runnersOnline?: number;
  // The AgentBus card: its build, the live dot, where the data comes from, and
  // Disconnect.
  version?: string;
  sourceLabel?: string;
  streamUp?: boolean;
  onDisconnect?: () => void;
  disconnectLabel?: string;
}

// ColumnFoot is the left column's foot, the same on the cockpit and on every
// page: the one foot nav (FootNav) then the AgentBus card — its name and build,
// a live dot, where the data comes from, and Disconnect. One component in one
// container, so the foot is identical everywhere; only which nav row is
// marked current changes. It stays put while the list above it scrolls.
export const ColumnFoot: React.FC<ColumnFootProps> = ({
  current,
  onCockpit,
  onApps,
  onRunners,
  onSettings,
  runnersOnline,
  version,
  sourceLabel = '',
  streamUp,
  onDisconnect,
  disconnectLabel = 'Disconnect',
}) => (
  <div className="brand-foot">
    <FootNav
      current={current}
      onCockpit={onCockpit}
      onApps={onApps}
      onRunners={onRunners}
      onSettings={onSettings}
      runnersOnline={runnersOnline}
      version={version}
    />
    <div className="bus-card">
      <span className="bc-row">
        <b className="brand">
          {PRODUCT.endsWith('Bus') ? (
            <>
              {PRODUCT.slice(0, -3)}
              <span className="bm-bus">Bus</span>
            </>
          ) : (
            PRODUCT
          )}
          {version && " "}
          {version && (
            <span className="bc-v" title="its build">
              {version}
            </span>
          )}
        </b>
      </span>
      <span className="bc-a gw">
        {streamUp !== undefined && (
          <i
            className={`live${streamUp ? '' : ' down'}`}
            title={streamUp ? 'Live' : 'Reconnecting'}
            aria-label={streamUp ? 'Live' : 'Reconnecting'}
          />
        )}
        {streamUp === false ? (
          // The stream is down: say so in words, not by the dot alone. The
          // address stays on hover.
          <span className="bc-addr bc-down" role="status" title={sourceLabel}>
            Disconnected · reconnecting…
          </span>
        ) : (
          <span className="bc-addr">{sourceLabel}</span>
        )}
        {onDisconnect && (
          <Button kind="link" className="disconnect" onClick={onDisconnect}>
            {disconnectLabel}
          </Button>
        )}
      </span>
    </div>
  </div>
);
