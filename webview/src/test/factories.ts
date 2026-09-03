import type {
  AgentEvent,
  AgentEventType,
  EventDataMap
} from '../../../src/events/types';
import {
  asAgentId,
  asEventId,
  asTaskId,
  EVENT_VERSION
} from '../../../src/events/types';

/**
 * Test factories rather than repeated fixtures.
 *
 * `makeEvent` is typed against the event map, so a test that supplies the
 * wrong payload for an event type fails to compile — the same guarantee the
 * production emit path has.
 */
let sequence = 0;

export function resetSequence(): void {
  sequence = 0;
}

export function makeEvent<T extends AgentEventType>(
  type: T,
  data: EventDataMap[T],
  options: { agentId?: string; sequence?: number; eventId?: string } = {}
): AgentEvent {
  sequence += 1;
  const seq = options.sequence ?? sequence;
  return {
    eventId: asEventId(options.eventId ?? `e-${seq}`),
    eventVersion: EVENT_VERSION,
    taskId: asTaskId('task-1'),
    agentId: options.agentId !== undefined ? asAgentId(options.agentId) : undefined,
    type,
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    sequence: seq,
    data
  } as AgentEvent;
}
