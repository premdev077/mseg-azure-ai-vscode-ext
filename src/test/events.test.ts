import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { EventBus, redactData } from '../events/bus';
import {
  AgentEvent,
  AgentEventType,
  EmitOptions,
  EVENT_VERSION
} from '../events/types';

function collect(bus: EventBus): AgentEvent[] {
  const seen: AgentEvent[] = [];
  bus.on((e) => seen.push(e));
  return seen;
}

test('every event is stamped with id, version, timestamp and sequence', () => {
  const bus = new EventBus();
  const event = bus.emit({ type: 'task.started', taskId: 't1', data: {} });

  assert.ok(event.eventId.length > 0);
  assert.equal(event.eventVersion, EVENT_VERSION);
  assert.equal(event.taskId, 't1');
  assert.equal(event.sequence, 1);
  assert.ok(!Number.isNaN(Date.parse(event.timestamp)));
});

test('event ids are unique across a busy run', () => {
  const bus = new EventBus();
  const ids = new Set<string>();
  for (let i = 0; i < 500; i++) {
    ids.add(
      bus.emit({ type: 'model.text', taskId: 't1', data: { delta: 'x' } }).eventId
    );
  }
  assert.equal(ids.size, 500);
});

test('sequence is monotonic across tasks, so one counter orders everything', () => {
  const bus = new EventBus();
  const a = bus.emit({ type: 'agent.started', taskId: 'alpha', data: {} });
  const b = bus.emit({ type: 'agent.started', taskId: 'beta', data: {} });
  const c = bus.emit({ type: 'agent.completed', taskId: 'alpha', data: {} });

  assert.deepEqual([a.sequence, b.sequence, c.sequence], [1, 2, 3]);
  assert.equal(bus.lastSequence, 3);
});

test('listeners receive events in emission order', () => {
  const bus = new EventBus();
  const seen = collect(bus);

  const types: AgentEventType[] = ['task.started', 'agent.created', 'model.started'];
  for (const type of types) {
    bus.emit({ type, taskId: 't1', data: {} } as EmitOptions);
  }

  assert.deepEqual(
    seen.map((e) => e.type),
    types
  );
  assert.deepEqual(
    seen.map((e) => e.sequence),
    [1, 2, 3]
  );
});

test('a throwing listener cannot stop the others or the emitter', () => {
  const bus = new EventBus();
  const good: string[] = [];
  bus.on(() => {
    throw new Error('subscriber is broken');
  });
  bus.on((e) => good.push(e.type));

  assert.doesNotThrow(() =>
    bus.emit({ type: 'notice', taskId: 't1', data: { message: 'note' } })
  );
  assert.deepEqual(good, ['notice']);
});

test('replay returns only what the caller has not seen', () => {
  const bus = new EventBus();
  for (let i = 0; i < 5; i++) {
    bus.emit({ type: 'model.text', taskId: 't1', data: { delta: String(i) } });
  }

  const { events, gap } = bus.replaySince('t1', 2);
  assert.equal(gap, false);
  assert.deepEqual(
    events.map((e) => e.sequence),
    [3, 4, 5]
  );
  const deltas = events
    .filter(
      (e): e is Extract<AgentEvent, { type: 'model.text' }> => e.type === 'model.text'
    )
    .map((e) => e.data.delta);
  assert.deepEqual(deltas, ['2', '3', '4']);
});

test('replay ignores other tasks', () => {
  const bus = new EventBus();
  bus.emit({ type: 'model.text', taskId: 'alpha', data: { delta: 'x' } });
  bus.emit({ type: 'model.text', taskId: 'beta', data: { delta: 'x' } });
  bus.emit({ type: 'model.text', taskId: 'alpha', data: { delta: 'x' } });

  const { events } = bus.replaySince('alpha', 0);
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.taskId === 'alpha'));
});

test('a fresh client asking from zero is not reported as a gap', () => {
  const bus = new EventBus({ bufferSize: 2 });
  for (let i = 0; i < 10; i++) {
    bus.emit({ type: 'model.text', taskId: 't1', data: { delta: 'x' } });
  }

  // Sequence 0 means "I have nothing", which is a new view, not a stale one.
  assert.equal(bus.replaySince('t1', 0).gap, false);
});

test('a client that fell behind the buffer is told there is a gap', () => {
  const bus = new EventBus({ bufferSize: 3 });
  for (let i = 0; i < 10; i++) {
    bus.emit({ type: 'model.text', taskId: 't1', data: { delta: 'x' } });
  }

  // Only sequences 8, 9, 10 are retained. A client that last saw 2 has missed
  // 3 through 7 permanently and must be told.
  const stale = bus.replaySince('t1', 2);
  assert.equal(stale.gap, true);
  assert.deepEqual(
    stale.events.map((e) => e.sequence),
    [8, 9, 10]
  );

  // A client that last saw 7 has missed nothing.
  const current = bus.replaySince('t1', 7);
  assert.equal(current.gap, false);
  assert.deepEqual(
    current.events.map((e) => e.sequence),
    [8, 9, 10]
  );
});

test('the buffer is bounded so a long run cannot grow without limit', () => {
  const bus = new EventBus({ bufferSize: 50 });
  for (let i = 0; i < 5000; i++) {
    bus.emit({ type: 'model.text', taskId: 't1', data: { delta: 'x' } });
  }
  assert.equal(bus.history('t1').length, 50);
  assert.equal(bus.lastSequence, 5000);
});

test('clearing a task frees its buffer but keeps the sequence counter', () => {
  const bus = new EventBus();
  bus.emit({ type: 'model.text', taskId: 't1', data: { delta: 'x' } });
  bus.clearTask('t1');

  assert.deepEqual(bus.history('t1'), []);
  assert.equal(
    bus.emit({ type: 'model.text', taskId: 't2', data: { delta: 'x' } }).sequence,
    2
  );
});

test('replaying an unknown task is empty rather than an error', () => {
  const bus = new EventBus();
  assert.deepEqual(bus.replaySince('never-existed', 4), { events: [], gap: false });
});

// --- redaction -------------------------------------------------------------

test('secrets are scrubbed before an event is retained or delivered', () => {
  const bus = new EventBus();
  const seen = collect(bus);

  bus.emit({
    type: 'tool.completed',
    taskId: 't1',
    data: { name: 'read_file', preview: 'AZURE_OPENAI_API_KEY=abcd1234efgh5678' }
  });

  const previewOf = (event: AgentEvent): string =>
    event.type === 'tool.completed' ? (event.data.preview ?? '') : '';
  const delivered = previewOf(seen[0]);
  const retained = previewOf(bus.history('t1')[0]);

  assert.ok(
    !delivered.includes('abcd1234efgh5678'),
    'delivered payload leaked the key'
  );
  assert.ok(!retained.includes('abcd1234efgh5678'), 'retained payload leaked the key');
  assert.match(delivered, /<REDACTED>/);
});

test('redaction reaches strings nested in objects and arrays', () => {
  const out = redactData({
    outer: {
      list: ['Bearer abcdefghijklmnopqrstuvwxyz012345', 'harmless'],
      nested: { token: 'SECRET_TOKEN=zzzzzzzzzzzz' }
    }
  });

  const json = JSON.stringify(out);
  assert.ok(!json.includes('abcdefghijklmnopqrstuvwxyz012345'));
  assert.ok(!json.includes('zzzzzzzzzzzz'));
  assert.ok(json.includes('harmless'), 'ordinary strings must survive');
});

test('redaction survives a cyclic payload instead of hanging the emit path', () => {
  const cyclic: Record<string, unknown> = { name: 'loop' };
  cyclic.self = cyclic;

  const out = redactData(cyclic);
  assert.equal(out.name, 'loop');
  assert.equal(out.self as Record<string, unknown> as unknown, '[circular]');
});

test('redaction stops at a depth limit rather than recursing forever', () => {
  let deep: Record<string, unknown> = { value: 'bottom' };
  for (let i = 0; i < 40; i++) {
    deep = { child: deep };
  }
  const out = redactData(deep);
  assert.ok(JSON.stringify(out).includes('[depth limit]'));
});

test('non-string values pass through untouched', () => {
  const out = redactData({ count: 42, ok: true, nothing: null });
  assert.deepEqual(out, { count: 42, ok: true, nothing: null });
});
