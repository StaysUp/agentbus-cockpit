import { describe, expect, it } from 'vitest';
import jsonlContent from '../../testdata/sessions-v0.jsonl?raw';
import { ReplayDataSource } from '../data/ReplayDataSource';
import { openSession } from './helpers';

describe('ReplayDataSource', () => {
  const dataSource = new ReplayDataSource(jsonlContent);

  it('parses agents correctly', async () => {
    const agents = await dataSource.getAgents();
    expect(agents.length).toBe(1);
    expect(agents[0].id).toBe('claude');
    expect(agents[0].name).toBe('Claude Code');
    expect(agents[0].sessionCount).toBe(2);
    expect(agents[0].usage.input_tokens).toBeGreaterThan(0);
    expect(agents[0].usage.output_tokens).toBeGreaterThan(0);
  });

  it('parses sessions correctly', async () => {
    const sessions = await dataSource.getSessions();
    expect(sessions.length).toBe(2);
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain('rec-tools');
    expect(ids).toContain('rec-chat');

    const recTools = sessions.find((s) => s.id === 'rec-tools');
    expect(recTools?.turns).toBe(2);
    expect(recTools?.title).toContain('Add a Sub function');

    const recChat = sessions.find((s) => s.id === 'rec-chat');
    expect(recChat?.turns).toBe(1);
    expect(recChat?.title).toContain('what is a table test in Go?');
  });

  it('extracts session details and turns inline', async () => {
    const detail = await openSession(dataSource, 'rec-tools');
    expect(detail).not.toBeNull();
    expect(detail?.turnsList.length).toBe(2);

    const turn1 = detail!.turnsList[0];
    expect(turn1.turnNumber).toBe(1);
    expect(turn1.prompt).toContain('Add a Sub function');
    expect(turn1.detail!.rawPrompt).toContain('<system-reminder>');
    expect(turn1.outcome).toBe('finished');
    expect(turn1.detail!.modelCalls.length).toBe(3);
    expect(turn1.detail!.toolCalls.length).toBe(4); // Bash, Edit, Write, Bash

    // Verify tool calls have inputs and outputs
    const firstTool = turn1.detail!.toolCalls[0];
    expect(firstTool.requested.tool_name).toBe('Bash');
    expect(firstTool.completed?.tool_output).toBeDefined();

    // Verify turn 2
    const turn2 = detail!.turnsList[1];
    expect(turn2.turnNumber).toBe(2);
    expect(turn2.prompt).toContain('Now add a Mul function');
    expect(turn2.detail!.modelCalls.length).toBe(2);
    expect(turn2.detail!.toolCalls.length).toBe(3); // Edit, Edit, Bash
    expect(turn2.detail!.agentResponse).toContain('Mul');
  });

  it('handles chat-only session', async () => {
    const detail = await openSession(dataSource, 'rec-chat');
    expect(detail).not.toBeNull();
    expect(detail?.turnsList.length).toBe(1);

    const turn = detail!.turnsList[0];
    expect(turn.prompt).toBe('In two sentences, what is a table test in Go?');
    expect(turn.detail!.modelCalls.length).toBe(1);
    expect(turn.detail!.toolCalls.length).toBe(0);
    expect(turn.detail!.agentResponse).toContain('A table test in Go');
  });
});
