// @vitest-environment jsdom
// A turn header's grey line: the agent, the model once, then the call count.
// How the line breaks is in turnHeadCss.test.ts.
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { turnHeadFacts } from '../components/ConvoColumn';
import { CockpitEvent, DataSource, SavedAgent } from '../types';
import { ev, liveReplay, render } from './helpers';

const MODEL = 'deepseek/deepseek-v4.1-flash';
const SAVED: SavedAgent[] = [
  // The agent form names a new agent by its harness and model.
  { id: 'a_ds', name: `Codex · ${MODEL}`, harness: 'codex', access: 'openrouter', model: MODEL },
];

function events(model: string): CockpitEvent[] {
  const t = 'T1';
  return [
    ev({ session: 's1', kind: 'turn.started', turn: t, text: 'hi', agent: 'codex', agent_id: 'a_ds', folder: '/w' }),
    ev({ session: 's1', kind: 'model.requested', turn: t, exchange: 'x1', model }),
    ev({ session: 's1', kind: 'model.responded', turn: t, exchange: 'x1', status: 200, text: 'a', stop_reason: 'tool_use' }),
    ev({ session: 's1', kind: 'model.requested', turn: t, exchange: 'x2', model }),
    ev({ session: 's1', kind: 'model.responded', turn: t, exchange: 'x2', status: 200, text: 'OK', stop_reason: 'end_turn' }),
    ev({ session: 's1', kind: 'turn.completed', turn: t, exchange: 'x2', outcome: 'finished' }),
  ];
}

async function header(model: string): Promise<string> {
  const base = liveReplay(events(model));
  const src: DataSource = { ...base.source, listAgents: async () => SAVED };
  const r = await render(<App dataSource={src} />);
  for (let i = 0; i < 100 && !r.container.querySelector('#convo .tb-h span'); i++) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 10));
    });
  }
  const text = r.container.querySelector('#convo .tb-h')!.textContent!;
  r.unmount();
  return text;
}

describe('turn header', () => {
  it('names the model once when the agent is named after it', async () => {
    expect(await header(MODEL)).toBe(`Turn 1 Codex · ${MODEL} · 2 model calls`);
  });

  it('keeps both when the turn ran another model than the name says', async () => {
    expect(await header('other/model')).toBe(`Turn 1 Codex · ${MODEL} · other/model · 2 model calls`);
  });

  it('turnHeadFacts: drops the name part that is the model, keeps a typed name', () => {
    expect(turnHeadFacts(`Codex · ${MODEL}`, MODEL)).toEqual({ agent: ['Codex'], model: MODEL });
    expect(turnHeadFacts(MODEL, MODEL)).toEqual({ agent: [], model: MODEL });
    expect(turnHeadFacts('Reviewer', MODEL)).toEqual({ agent: ['Reviewer'], model: MODEL });
    expect(turnHeadFacts('Codex', undefined)).toEqual({ agent: ['Codex'], model: undefined });
    expect(turnHeadFacts('', MODEL)).toEqual({ agent: [], model: MODEL });
  });
});
