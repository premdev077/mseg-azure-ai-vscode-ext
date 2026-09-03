import { redact } from '../redact';
import {
  AgentEvent,
  asAgentId,
  asEventId,
  asTaskId,
  EmitOptions,
  EVENT_VERSION,
  ReplayResult
} from './types';

/**
 * How many events are retained per task for replay. A busy agent run streams
 * text deltas by the hundred, so this is sized for "the webview reloaded
 * mid-task", not "reconstruct the session from cold".
 */
const DEFAULT_BUFFER = 2000;

export interface EventBusOptions {
  /** Retained events per task. */
  bufferSize?: number;
  /** Injectable for tests; defaults to `Date.now`-based ISO strings. */
  now?: () => Date;
}

type Listener = (event: AgentEvent) => void;

/**
 * The single emit path for the agent system.
 *
 * In-process by design: the extension host and the webview are two contexts in
 * one VS Code process joined by `postMessage`, so there is no connection to
 * drop and nothing to reconnect. What a webview actually loses is its whole
 * DOM on reload, which is why this keeps a per-task ring buffer and can replay
 * everything after a given sequence instead.
 *
 * Every payload passes through `redact()` before it is retained or delivered,
 * so a secret cannot reach the panel, the buffer or a log by any route.
 */
export class EventBus {
  private readonly listeners = new Set<Listener>();
  private readonly buffers = new Map<string, AgentEvent[]>();
  private readonly bufferSize: number;
  private readonly now: () => Date;
  private seq = 0;
  /** Oldest sequence still retained, per task, for gap detection. */
  private readonly oldest = new Map<string, number>();
  private counter = 0;

  constructor(options: EventBusOptions = {}) {
    this.bufferSize = Math.max(1, options.bufferSize ?? DEFAULT_BUFFER);
    this.now = options.now ?? (() => new Date());
  }

  /** The highest sequence issued so far. 0 before anything is emitted. */
  get lastSequence(): number {
    return this.seq;
  }

  on(listener: Listener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  emit(options: EmitOptions): AgentEvent {
    this.seq += 1;
    this.counter += 1;

    const event = {
      eventId: asEventId(
        `ev-${this.seq}-${this.counter.toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 8)}`
      ),
      eventVersion: EVENT_VERSION,
      taskId: asTaskId(options.taskId),
      agentId: options.agentId ? asAgentId(options.agentId) : undefined,
      parentEventId: options.parentEventId
        ? asEventId(options.parentEventId)
        : undefined,
      type: options.type,
      timestamp: this.now().toISOString(),
      sequence: this.seq,
      data: redactData(options.data ?? {})
      // The map from `options.type` to `options.data` is already enforced by
      // EmitOptions; TypeScript cannot carry that correlation through the
      // object literal, so the union is re-asserted here rather than widened.
    } as AgentEvent;

    this.retain(event);

    // A throwing listener must not take down the emitter or stop the other
    // listeners — an event stream that can be broken by one bad subscriber is
    // worse than no event stream.
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error('Azure AI Chat: event listener threw', err);
      }
    }

    return event;
  }

  private retain(event: AgentEvent): void {
    let buffer = this.buffers.get(event.taskId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(event.taskId, buffer);
      this.oldest.set(event.taskId, event.sequence);
    }
    buffer.push(event);
    if (buffer.length > this.bufferSize) {
      const dropped = buffer.splice(0, buffer.length - this.bufferSize);
      const first = buffer[0] ?? dropped[dropped.length - 1];
      this.oldest.set(event.taskId, first.sequence);
    }
  }

  /**
   * Everything for `taskId` after `afterSequence`, in order.
   *
   * `gap` is true when the caller has fallen behind further than the buffer
   * reaches. Reporting that is the point: a UI that silently renders a partial
   * run is worse than one that says it missed something.
   */
  replaySince(taskId: string, afterSequence: number): ReplayResult {
    const buffer = this.buffers.get(taskId);
    if (!buffer || buffer.length === 0) {
      return { events: [], gap: false };
    }
    const oldest = this.oldest.get(taskId) ?? buffer[0].sequence;
    return {
      events: buffer.filter((e) => e.sequence > afterSequence),
      // Sequence 0 means "I have nothing yet", which is a fresh client rather
      // than one that fell behind.
      gap: afterSequence > 0 && oldest > afterSequence + 1
    };
  }

  /** Every retained event for a task, oldest first. */
  history(taskId: string): AgentEvent[] {
    return [...(this.buffers.get(taskId) ?? [])];
  }

  /** Frees a finished task's buffer. Sequence numbers keep counting. */
  clearTask(taskId: string): void {
    this.buffers.delete(taskId);
    this.oldest.delete(taskId);
  }

  dispose(): void {
    this.listeners.clear();
    this.buffers.clear();
    this.oldest.clear();
  }
}

/**
 * Recursively redacts strings in an event payload.
 *
 * Depth-limited and cycle-safe: payloads come from tool results and model
 * output, so they are not guaranteed to be shallow or acyclic, and the emit
 * path must never be the thing that hangs a turn.
 */
export function redactData<T>(value: T): T {
  // `walk` preserves shape and only rewrites string leaves, so the input
  // type still describes the result.
  return walk(value, 0, new WeakSet()) as T;
}

const MAX_DEPTH = 8;

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redact(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return '[depth limit]';
  }
  if (seen.has(value as object)) {
    return '[circular]';
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = walk(item, depth + 1, seen);
  }
  return out;
}
