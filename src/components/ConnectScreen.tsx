import React, { useState } from 'react';
import { DEFAULT_JOBS_ADDRESS } from '../data/connection';

interface ConnectScreenProps {
  address: string;
  onAddressChange: (address: string) => void;
  checking: boolean;
  error: string | null;
  // jobs: a control plane to use too, when its token was given.
  onConnect: (address: string, token: string, jobs?: { address: string; token: string }) => void;
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
  // The control plane is optional: it is used only when a token is given.
  const [jobsAddress, setJobsAddress] = useState(DEFAULT_JOBS_ADDRESS);
  const [jobsToken, setJobsToken] = useState('');
  return (
    <div id="connect-wrap">
      <form
        className="connect"
        onSubmit={(e) => {
          e.preventDefault();
          if (checking) return;
          const jobs = jobsToken.trim() ? { address: jobsAddress, token: jobsToken.trim() } : undefined;
          onConnect(address, token, jobs);
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
        <div className="connect-sec">
          Control plane <span>optional: runs each turn as a job on a runner, and adds Review</span>
        </div>
        <label>
          <span>Address</span>
          <input
            name="jobs-address"
            type="text"
            value={jobsAddress}
            onChange={(e) => setJobsAddress(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label>
          <span>Token</span>
          <input
            name="jobs-token"
            type="password"
            value={jobsToken}
            onChange={(e) => setJobsToken(e.target.value)}
            placeholder="leave empty to skip"
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
