import { TurnState, Usage } from '../types';

// Colour only for status: a failed turn is red, a finished one green.
export function stateClass(state: TurnState): string {
  if (state === 'failed') return 'bad';
  if (state === 'finished') return 'ok';
  return 'dim';
}

// How a turn's state reads: a finished turn by its outcome, when it has one.
export function stateLabel(turn: { state: TurnState; outcome?: string }): string {
  return turn.state === 'finished' ? turn.outcome || 'finished' : turn.state;
}

// Tokens in all. Unknown usage (null: no reply carried any) is a dash, never 0.
export function formatTokens(usage?: Usage | null): string {
  if (usage === null) return '—';
  if (!usage) return '0';
  const total =
    (usage.input_tokens || 0) +
    (usage.output_tokens || 0) +
    (usage.cache_read_tokens || 0) +
    (usage.cache_write_tokens || 0);
  if (total >= 1000) {
    return (total / 1000).toFixed(1) + 'k';
  }
  return total.toLocaleString();
}

export const COST_INCOMPLETE_TITLE = 'some calls could not be fully priced';

// Money in USD. null or undefined means no cost is known: show nothing, never
// "$0.00". An incomplete cost is a lower bound: a leading "≥", rounded down so
// the bound stays true.
export function formatCost(usd: number | null | undefined, complete = true): string {
  if (usd === null || usd === undefined || isNaN(usd)) return '';
  // Exactly nothing spent is shown as such, not as "<$0.01".
  if (usd === 0) return complete ? '$0' : '≥$0';
  if (!complete) {
    // The epsilon absorbs float error: 1.15 * 100 is 114.99999999999999.
    if (usd >= 100) return `≥$${Math.floor(usd + 1e-6)}`;
    return `≥$${(Math.floor(usd * 100 + 1e-6) / 100).toFixed(2)}`;
  }
  if (usd < 0.01) return '<$0.01';
  if (usd >= 100) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatCount(val: number): string {
  if (val >= 1000) {
    return (val / 1000).toFixed(1) + 'k';
  }
  return val.toString();
}

export function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toTimeString().split(' ')[0];
  } catch {
    return isoString;
  }
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null || isNaN(ms)) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function toolInputSummary(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>;
    if (typeof obj.command === 'string') return obj.command;
    if (typeof obj.file_path === 'string') {
      return `${obj.file_path} ${obj.new_string ? '(edit)' : ''}`;
    }
    return JSON.stringify(input);
  }
  return String(input);
}
