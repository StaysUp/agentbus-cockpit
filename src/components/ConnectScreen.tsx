import React, { useState } from 'react';

interface ConnectScreenProps {
  address: string;
  onAddressChange: (address: string) => void;
  checking: boolean;
  error: string | null;
  onConnect: (address: string, token: string) => void;
  onUseRecorded: () => void;
  // Served by agentbus itself: say how to get a sign-in link.
  served?: boolean;
}

export const ConnectScreen: React.FC<ConnectScreenProps> = ({
  address,
  onAddressChange,
  checking,
  error,
  onConnect,
  onUseRecorded,
  served = false,
}) => {
  // The token lives only in this field until a check passes.
  const [token, setToken] = useState('');
  return (
    <div id="connect-wrap">
      <form
        className="connect"
        onSubmit={(e) => {
          e.preventDefault();
          if (checking) return;
          onConnect(address, token);
        }}
      >
        <div className="brand">AgentBus</div>
        {served && (
          <p className="connect-hint">
            Run <code>agentbus open</code> in a terminal for a sign-in link, or paste the token from the data folder.
          </p>
        )}
        <label>
          <span>Service</span>
          <input
            name="address"
            type="text"
            value={address}
            onChange={(e) => onAddressChange(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label>
          <span>Token</span>
          <input
            name="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
        </label>
        {error && <div className="connect-error">{error}</div>}
        <div className="connect-actions">
          <button type="submit" className="btn btn-primary connect-go" disabled={checking}>
            {checking ? 'Checking…' : 'Connect'}
          </button>
          <button type="button" className="btn btn-secondary use-recorded" onClick={onUseRecorded}>
            Use recorded data
          </button>
        </div>
      </form>
    </div>
  );
};
