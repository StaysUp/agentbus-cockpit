import React, { useEffect, useState } from 'react';
import { HeldApproval, ApprovalGone, ApprovalDecision } from '../types';
import { harnessName } from '../words';
import { Button } from './Controls';
import { Notice } from './Notice';

// The gateway holds an Ask reply for this long (gateway.HoldTimeout) while it
// waits for an answer; after it, the held call is refused for want of one and
// the card disappears. The card shows the time left as a countdown so a person
// knows the agent is waiting on them now, in the same turn, not later.
const HOLD_SECONDS = 60;

function secondsLeft(requested: string): number {
  const started = Date.parse(requested);
  if (Number.isNaN(started)) return HOLD_SECONDS;
  return Math.max(0, Math.ceil(HOLD_SECONDS - (Date.now() - started) / 1000));
}

// One card for a command an agent wanted to run that the gateway held for a
// person: a command on the ask list, or one on none of the lists under the ask
// default. Allow once lets exactly these commands run for the continuation turn
// only, writing nothing to the settings; Always allow moves the matched command
// to the allow list, from now on; Refuse records the decision. When another
// answer already took it (409), the card steps aside.
export const ApprovalCard: React.FC<{
  approval: HeldApproval;
  decide: (id: string, decision: ApprovalDecision) => Promise<void>;
}> = ({ approval, decide }) => {
  const [busy, setBusy] = useState<'' | ApprovalDecision>('');
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(() => secondsLeft(approval.requested));

  // Tick the countdown each second while the hold is live. The card unmounts
  // when the approval stops listing (answered or timed out), which clears it.
  useEffect(() => {
    setLeft(secondsLeft(approval.requested));
    const t = setInterval(() => setLeft(secondsLeft(approval.requested)), 1000);
    return () => clearInterval(t);
  }, [approval.requested]);

  const isFolderTool = approval.tool_name === 'read_file' || approval.tool_name === 'list_folder' || approval.tool_name === 'write_file';

  const answer = async (decision: ApprovalDecision) => {
    setBusy(decision);
    setError(null);
    try {
      await decide(approval.id, decision);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === ApprovalGone) setGone(true);
      else setError(msg);
    } finally {
      setBusy('');
    }
  };

  if (gone) {
    return (
      <div className="ask-card ask-card-gone" role="status">
        This command is already being answered.
      </div>
    );
  }

  return (
    <div className="ask-card" role="group" aria-label="A command to approve">
      <div className="ask-card-head">
        <span>{approval.agent ? harnessName(approval.agent) : 'An agent'} wants to run:</span>
        <span className="ask-card-countdown" role="timer" aria-live="off">
          {left > 0 ? `${left}s to answer` : 'timing out…'}
        </span>
      </div>
      <ul className="ask-card-cmds">
        {approval.commands.map((c, i) => (
          <li key={i}>
            <code>{c}</code>
          </li>
        ))}
      </ul>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="ask-card-actions">
        <Button kind="secondary" className="ask-refuse" disabled={busy !== ''} onClick={() => answer('refuse')}>
          {busy === 'refuse' ? '…' : 'Refuse'}
        </Button>
        <Button kind="secondary" className="ask-always" disabled={busy !== ''} onClick={() => answer('always')}>
          {busy === 'always' ? '…' : isFolderTool ? 'Always for this folder' : 'Always allow'}
        </Button>
        <Button kind="primary" className="ask-allow" disabled={busy !== ''} onClick={() => answer('once')}>
          {busy === 'once' ? '…' : 'Allow once'}
        </Button>
      </div>
      <div className="ask-card-note">
        {isFolderTool
          ? 'Allow once runs it this turn only. Always for this folder grants this folder, from now on. Refuse records the decision.'
          : 'Allow once runs it this turn only. Always allow adds it to the allow list, from now on. Refuse records the decision.'}
      </div>
    </div>
  );
};
