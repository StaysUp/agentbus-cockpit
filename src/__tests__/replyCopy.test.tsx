// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ConvoColumn } from '../components/ConvoColumn';
import type { SessionDetail, Turn } from '../types';
import { click, render } from './helpers';

const REPLY = '## Result\n\nUse **two** spaces and `code`.';

function sessionWithReply(reply: string): SessionDetail {
  const turn: Turn = {
    id: 'T1',
    turnNumber: 1,
    sessionId: 'copy',
    startedAt: '2026-11-24T09:00:00Z',
    prompt: 'Explain',
    state: 'finished',
    reply,
    usage: null,
    costUsd: null,
    costComplete: true,
  };
  return {
    id: 'copy',
    agent: 'claude',
    client: '',
    title: 'copy',
    started: '2026-11-24T09:00:00Z',
    last: '2026-11-24T09:01:00Z',
    open: false,
    turns: 1,
    usage: { input_tokens: 0, output_tokens: 0 },
    turnsList: [turn],
  };
}

describe('copy an agent reply', () => {
  it('copies the markdown the agent wrote and confirms it', async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (text: string) => { copied.push(text); } },
      configurable: true,
    });

    const r = await render(
      <ConvoColumn session={sessionWithReply(REPLY)} selectedTurn={null} onSelectTurn={() => {}} />,
    );
    const button = r.container.querySelector<HTMLButtonElement>('button[aria-label="Copy this reply"]')!;
    // The rendered reply shows the heading, not its markdown markers.
    expect(r.container.querySelector('.m-agent')!.textContent).toContain('Result');
    expect(r.container.querySelector('.m-agent')!.textContent).not.toContain('## Result');

    await click(button);

    expect(copied).toEqual([REPLY]);
    expect(button.getAttribute('title')).toBe('Copied!');
    r.unmount();
  });

  it('keeps the copy control in the reply block on every turn with an answer', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const r = await render(
      <ConvoColumn session={sessionWithReply('one')} selectedTurn={null} onSelectTurn={() => {}} />,
    );
    const block = r.container.querySelector('.m-agent')!;
    expect(block.querySelector('.reply-actions button.copy')).not.toBeNull();
    r.unmount();
  });
});
