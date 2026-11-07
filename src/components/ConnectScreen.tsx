import React, { useState } from 'react';

interface ConnectScreenProps {
  address: string;
  onAddressChange: (address: string) => void;
  checking: boolean;
  error: string | null;
  onConnect: (address: string, token: string) => void;
  onUseRecorded: () => void;
}

export const ConnectScreen: React.FC<ConnectScreenProps> = ({
  address,
  onAddressChange,
  checking,
  error,
  onConnect,
  onUseRecorded,
}) => {
  // The token lives only in this field until a check passes.
  const [token, setToken] = useState('');
  return (
    <div id="connect-wrap">
      <form
        className="connect"
        onSubmit={(e) => {
          e.preventDefault();
          if (!checking) onConnect(address, token);
        }}
      >
        <div className="brand">AgentBus</div>
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
          <button type="submit" className="connect-go" disabled={checking}>
            {checking ? 'Checking…' : 'Connect'}
          </button>
          <button type="button" className="use-recorded" onClick={onUseRecorded}>
            Use recorded data
          </button>
        </div>
      </form>
    </div>
  );
};
