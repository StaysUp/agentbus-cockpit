// @vitest-environment jsdom
// Selecting text in a turn, to copy it, does not open the turn's panel. A
// plain click on the turn still does, at once.
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConvoColumn } from '../components/ConvoColumn';
import { createEmptyUsage } from '../data/turns';
import { SessionDetail, Turn } from '../types';
import { render } from './helpers';

const TURN: Turn = {
  id: 'T1',
  turnNumber: 1,
  sessionId: 'p',
  startedAt: '2026-11-25T01:00:00Z',
  prompt: 'what is in the folder',
  agentResponse: 'Two files: a.txt and b.txt.',
  agent: 'claude',
  agentId: 'claude',
  state: 'finished',
  usage: null,
  costUsd: null,
  costComplete: true,
} as Turn;

const SESSION = {
  id: 'p',
  title: 'p',
  agent: 'claude',
  turns: 1,
  turnsList: [TURN],
  usage: createEmptyUsage(),
} as unknown as SessionDetail;

function click(el: Element, detail = 1) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
}

describe('selecting text in a turn', () => {
  afterEach(() => window.getSelection()?.removeAllRanges());

  it('a click that ends a selection in the turn does not open it; a plain click does, at once', async () => {
    const picked: string[] = [];
    const r = await render(<ConvoColumn session={SESSION} selectedTurn={null} onSelectTurn={(t) => picked.push(t.id)} />);
    const block = r.container.querySelector('.tb')!;
    const reply = block.querySelector('.m-agent, .bubble')!;
    // The person drags across the text: the click that ends it finds a selection.
    const range = document.createRange();
    range.selectNodeContents(reply);
    window.getSelection()!.addRange(range);
    expect(window.getSelection()!.toString()).not.toBe('');
    await act(async () => click(block));
    expect(picked).toEqual([]);
    // The second and third click of a double or triple click: not a pick.
    window.getSelection()!.removeAllRanges();
    await act(async () => click(block, 2));
    await act(async () => click(block, 3));
    expect(picked).toEqual([]);
    // A plain click, nothing selected: the turn opens at once, with no wait.
    await act(async () => click(block));
    expect(picked).toEqual(['T1']);
    r.unmount();
  });

  it('a selection somewhere else on the page does not stop a click on the turn', async () => {
    const picked: string[] = [];
    const outside = document.createElement('p');
    outside.textContent = 'text outside the conversation';
    document.body.appendChild(outside);
    const r = await render(<ConvoColumn session={SESSION} selectedTurn={null} onSelectTurn={(t) => picked.push(t.id)} />);
    const range = document.createRange();
    range.selectNodeContents(outside);
    window.getSelection()!.addRange(range);
    await act(async () => click(r.container.querySelector('.tb')!));
    expect(picked).toEqual(['T1']);
    r.unmount();
    outside.remove();
  });
});
