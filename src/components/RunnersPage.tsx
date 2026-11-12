import React from 'react';
import { PageFrame } from './PageFrame';
import { RunnersList, RunnersState } from './RunnersList';

interface RunnersPageProps extends RunnersState {
  onBack: () => void;
}

// The runners page (/runners): every runner and connector control knows.
export const RunnersPage: React.FC<RunnersPageProps> = ({ runners, error, onBack }) => (
  <PageFrame title="Runners" onBack={onBack}>
    {runners === undefined && !error && <p className="dim">Reading…</p>}
    {runners === null && <p className="dim">This service keeps no runners.</p>}
    <RunnersList runners={runners} error={error} />
  </PageFrame>
);
