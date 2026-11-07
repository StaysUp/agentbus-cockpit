import React from 'react';
import { COST_INCOMPLETE_TITLE, formatCost } from '../utils/format';

// A cost in USD, or nothing when none is known. An incomplete one is a lower
// bound and says why on hover.
export const Cost: React.FC<{ usd?: number | null; complete?: boolean; className?: string }> = ({
  usd,
  complete = true,
  className,
}) => {
  const text = formatCost(usd, complete);
  if (!text) return null;
  return (
    <span className={className} title={complete ? undefined : COST_INCOMPLETE_TITLE}>
      {text}
    </span>
  );
};
