import React, { useState } from 'react';
import { Button } from './Controls';
import { BusMark } from './Icons';
import { Notice, WithCode } from './Notice';
import { PRODUCT } from '../words';

interface ConnectScreenProps {
  address: string;
  onAddressChange: (address: string) => void;
  checking: boolean;
  error: string | null;
  onConnect: (address: string, token: string) => void;
  // Served by agentbus itself: say how to get a sign-in link.
  served?: boolean;
}

export const ConnectScreen: React.FC<ConnectScreenProps> = ({
  address,
  onAddressChange,
  checking,
  error,
  onConnect,
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
        <div className="brand">
          <BusMark />
          Agent<span className="bm-bus">Bus</span>
        </div>
        <p className="connect-hint">
          {served ? (
            <>
              For a new sign-in link, start <code>agentbus up</code> again.
            </>
          ) : (
            <>
              <code>agentbus up</code> prints a sign-in link.
            </>
          )}{' '}
          Or paste the token: the file <code>token</code> in the data folder <code>agentbus up</code> printed when it started.
        </p>
        <label>
          <span>{PRODUCT} address</span>
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
        {error && (
          <Notice kind="error" className="connect-error">
            <WithCode text={error} />
          </Notice>
        )}
        <div className="connect-actions">
          <Button kind="primary" type="submit" className="connect-go" disabled={checking}>
            {checking ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      </form>
    </div>
  );
};
