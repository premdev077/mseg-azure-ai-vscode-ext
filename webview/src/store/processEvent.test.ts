import { describe, expect, it } from 'vitest';
import {
  initialAppState,
  processEvent,
  processEvents,
  type AppState
} from './processEvent';
import { makeEvent, resetSequence } from '../test/factories';
import type { AgentEvent } from '../../../src/events/types';

function fold(...events: AgentEvent[]): AppState {
  return processEvents(initialAppState, events);
}

describe('idempotency', () => {
  it('drops an event it has already applied', () => {
    resetSequence();
    const event = makeEvent('model.text', { delta: 'hello' });

    const once = processEvent(initialAppState, event);
    const twice = processEvent(once, event);

    expect(once.chat.messages[0]?.text).toBe('hello');
    expect(twice.chat.messages[0]?.text).toBe('hello');
    expect(twice.stream.duplicateEvents).toBe(1);
  });

  it('survives a replay that overlaps what the view already has', () => {
    // This is the reload path: the host replays from the start, and the tail
    // of that replay is events the view applied moments earlier.
    resetSequence();
    const a = makeEvent('model.text', { delta: 'one ' });
    const b = makeEvent('model.text', { delta: 'two ' });
    const c = makeEvent('model.text', { delta: 'three' });

    const live = fold(a, b, c);
    const afterReplay = processEvents(live, [a, b, c]);

    expect(afterReplay.chat.messages[0]?.text).toBe('one two three');
    expect(afterReplay.stream.duplicateEvents).toBe(3);
  });

  it('rebuilds a transcript from a full replay into empty state', () => {
    // The other half of the reload path: React state is gone, so the whole log
    // arrives and must reconstruct what was there.
    resetSequence();
    const log = [
      makeEvent('task.started', {}),
      makeEvent('model.text', { delta: 'Answer ' }),
      makeEvent('model.text', { delta: 'text.' }),
      makeEvent('model.completed', { usageNote: '120 tokens' })
    ];

    const rebuilt = processEvents(initialAppState, log);

    expect(rebuilt.chat.messages[0]?.text).toBe('Answer text.');
    expect(rebuilt.chat.messages[0]?.streaming).toBe(false);
    expect(rebuilt.chat.usageNote).toBe('120 tokens');
  });
});

describe('ordering', () => {
  it('applies a batch by sequence, not by arrival', () => {
    resetSequence();
    const first = makeEvent(
      'model.text',
      { delta: 'A' },
      { sequence: 1, eventId: 'e1' }
    );
    const second = makeEvent(
      'model.text',
      { delta: 'B' },
      { sequence: 2, eventId: 'e2' }
    );
    const third = makeEvent(
      'model.text',
      { delta: 'C' },
      { sequence: 3, eventId: 'e3' }
    );

    const shuffled = processEvents(initialAppState, [third, first, second]);
    expect(shuffled.chat.messages[0]?.text).toBe('ABC');
  });

  it('never rewinds the sequence cursor', () => {
    resetSequence();
    const later = makeEvent(
      'notice',
      { message: 'later' },
      { sequence: 10, eventId: 'e10' }
    );
    const earlier = makeEvent(
      'notice',
      { message: 'earlier' },
      { sequence: 2, eventId: 'e2' }
    );

    const state = processEvent(processEvent(initialAppState, later), earlier);
    expect(state.stream.lastSequence).toBe(10);
  });
});

describe('forward compatibility', () => {
  it('applies an event whose version it does not recognise', () => {
    resetSequence();
    const event = { ...makeEvent('model.text', { delta: 'hi' }), eventVersion: '99' };
    const state = processEvent(initialAppState, event);

    // Known fields still land; the panel does not break because the host is newer.
    expect(state.chat.messages[0]?.text).toBe('hi');
  });

  it('leaves state untouched for an event no panel displays', () => {
    resetSequence();
    const before = fold(makeEvent('model.text', { delta: 'x' }));
    const after = processEvent(before, makeEvent('file.locked', { filePath: 'a.ts' }));

    expect(after.chat).toBe(before.chat);
    expect(after.agents).toBe(before.agents);
    expect(after.changes).toBe(before.changes);
  });
});

describe('parallel agents', () => {
  it('seeds a card per planner so concurrent work is visible at once', () => {
    resetSequence();
    const state = fold(
      makeEvent('planning.started', {
        planners: ['repository', 'architecture', 'testing'],
        count: 3
      })
    );

    expect(state.agents.ids).toHaveLength(3);
    expect(Object.values(state.agents.byId).map((a) => a.label)).toEqual([
      'Repository',
      'Architecture',
      'Testing'
    ]);
  });

  it('lets agents run and settle independently', () => {
    resetSequence();
    const state = fold(
      makeEvent('planning.started', { planners: ['a', 'b'], count: 2 }),
      makeEvent(
        'planning.agent.started',
        { planner: 'a', label: 'A', model: 'm' },
        { agentId: 'plan-a' }
      ),
      makeEvent(
        'planning.agent.started',
        { planner: 'b', label: 'B', model: 'm' },
        { agentId: 'plan-b' }
      ),
      makeEvent(
        'planning.agent.completed',
        { planner: 'a', label: 'A', confidence: 0.9, files: 2, changes: 1 },
        { agentId: 'plan-a' }
      )
    );

    expect(state.agents.byId['plan-a']?.status).toBe('completed');
    expect(state.agents.byId['plan-b']?.status).toBe('running');
  });

  it('ignores a progress update for an agent that already finished', () => {
    resetSequence();
    const state = fold(
      makeEvent('agent.started', { role: 'coder' }, { agentId: 'coder-1' }),
      makeEvent('agent.completed', { role: 'coder' }, { agentId: 'coder-1' }),
      makeEvent(
        'tool.started',
        { name: 'read_file', args: 'late.ts' },
        { agentId: 'coder-1' }
      )
    );

    expect(state.agents.byId['coder-1']?.status).toBe('completed');
    expect(state.agents.byId['coder-1']?.activity).toBe('Done');
  });

  it('cancels everything unfinished without disturbing settled agents', () => {
    resetSequence();
    const state = fold(
      makeEvent('planning.started', { planners: ['a', 'b'], count: 2 }),
      makeEvent(
        'planning.agent.started',
        { planner: 'a', label: 'A', model: 'm' },
        { agentId: 'plan-a' }
      ),
      makeEvent(
        'planning.agent.completed',
        { planner: 'a', label: 'A', confidence: 1, files: 1, changes: 1 },
        { agentId: 'plan-a' }
      ),
      makeEvent('task.cancelled', {})
    );

    expect(state.agents.byId['plan-a']?.status).toBe('completed');
    expect(state.agents.byId['plan-b']?.status).toBe('cancelled');
  });
});

describe('safety', () => {
  it('never stores model reasoning', () => {
    resetSequence();
    const state = fold(
      makeEvent('model.reasoning', { delta: 'let me think about this' })
    );

    expect(state.chat.messages).toHaveLength(0);
    expect(state.stream.phaseLabel).toBe('Thinking');
    expect(JSON.stringify(state)).not.toContain('let me think');
  });

  it('reports a verification verdict exactly as the verifier gave it', () => {
    resetSequence();
    const state = fold(
      makeEvent('verification.started', { attempt: 1, model: 'm', files: 2 }),
      makeEvent('verification.failed', {
        attempt: 1,
        passed: false,
        tests: 'failed',
        typecheck: 'passed',
        lint: 'passed',
        build: 'skipped',
        issues: 2,
        fixes: 1
      })
    );

    expect(state.verification.verification?.status).toBe('failed');
    expect(state.verification.verification?.build).toBe('skipped');
    expect(state.stream.phase).not.toBe('completed');
  });

  it('shows an unreported check as pending, never as passed', () => {
    resetSequence();
    const state = fold(
      makeEvent('verification.started', { attempt: 1, model: 'm', files: 0 })
    );
    expect(state.verification.verification?.tests).toBe('pending');
  });
});

describe('bounds', () => {
  it('caps tool history so a long run cannot grow without limit', () => {
    resetSequence();
    let state = initialAppState;
    for (let i = 0; i < 400; i++) {
      state = processEvent(
        state,
        makeEvent('tool.started', { name: 'read_file', args: `f${i}.ts` })
      );
    }
    expect(state.stream.tools.length).toBeLessThanOrEqual(200);
  });

  it('caps the transcript', () => {
    resetSequence();
    let state = initialAppState;
    for (let i = 0; i < 260; i++) {
      state = processEvent(state, makeEvent('model.text', { delta: `m${i}` }));
      state = processEvent(state, makeEvent('model.completed', {}));
    }
    expect(state.chat.messages.length).toBeLessThanOrEqual(200);
  });

  it('caps the dedupe set without losing recent ids', () => {
    resetSequence();
    let state = initialAppState;
    for (let i = 0; i < 6000; i++) {
      state = processEvent(state, makeEvent('notice', { message: `n${i}` }));
    }
    expect(state.seen.size).toBeLessThanOrEqual(5000);

    // The most recent event is still remembered, so a replay of it is dropped.
    const last = makeEvent('notice', { message: 'final' }, { eventId: 'final' });
    const applied = processEvent(state, last);
    const again = processEvent(applied, last);
    expect(again.stream.duplicateEvents).toBe(1);
  });
});

describe('changes', () => {
  it('keeps a rejected edit on the list rather than dropping it', () => {
    resetSequence();
    const state = fold(
      makeEvent('file.edit.proposed', {
        id: 'e1',
        relPath: 'src/a.ts',
        added: 5,
        removed: 1,
        isNewFile: false
      }),
      makeEvent('file.edit.resolved', { id: 'e1', decision: 'rejected' })
    );

    expect(state.changes.paths).toEqual(['src/a.ts']);
    expect(state.changes.byPath['src/a.ts']?.status).toBe('rejected');
  });
});
