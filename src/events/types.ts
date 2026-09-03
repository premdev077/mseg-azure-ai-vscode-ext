/**
 * The event contract every part of the agent system reports through.
 *
 * One stamped, ordered stream is what makes a multi-agent run answerable after
 * the fact: which agent changed this file, why it was waiting, how long it ran.
 *
 * `data` is typed per event type through `EventDataMap` rather than left as a
 * loose bag. That is what makes adding an event type a compile error at every
 * place that handles events, instead of a silent no-op discovered in the UI.
 */

/** Branded ids, so a taskId can never be passed where an agentId belongs. */
type Brand<T, B extends string> = T & { readonly __brand: B };
export type TaskId = Brand<string, 'TaskId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type EventId = Brand<string, 'EventId'>;

export const asTaskId = (value: string): TaskId => value as TaskId;
export const asAgentId = (value: string): AgentId => value as AgentId;
export const asEventId = (value: string): EventId => value as EventId;

/** Bumped only when a field changes meaning, so a stored log stays readable. */
export const EVENT_VERSION = '1';

export type NodeRole =
  'chat' | 'coordinator' | 'planner' | 'coder' | 'verifier' | 'repair';
export type Decision = 'accepted' | 'rejected' | 'approved';
export type CheckOutcomeName = 'passed' | 'failed' | 'skipped';

/**
 * The payload shape of every event type.
 *
 * Phase-level and agent-level planning are separate types on purpose: they
 * carry different data, and one name serving both meant every reader had to
 * sniff which it had. The type map made that ambiguity visible.
 */
export interface EventDataMap {
  'task.created': { taskId: string };
  'task.started': { state?: string; mode?: string };
  'task.completed': {
    state?: string;
    succeeded?: number;
    failed?: number;
    skipped?: number;
  };
  'task.failed': {
    state?: string;
    error?: string;
    succeeded?: number;
    failed?: number;
    skipped?: number;
    stoppedEarly?: string;
  };
  'task.cancelled': { state?: string };

  'agent.created': {
    nodeId: string;
    role?: NodeRole;
    priority?: string;
    waitedOn?: string[];
  };
  'agent.started': { nodeId?: string; objective?: string; role?: NodeRole };
  'agent.state': { state: string; label: string };
  'agent.completed': { nodeId?: string; role?: NodeRole; durationMs?: number };
  'agent.failed': {
    nodeId?: string;
    role?: NodeRole;
    durationMs?: number;
    error?: string;
  };
  'agent.cancelled': { nodeId?: string; role?: NodeRole };

  'model.started': Record<string, never>;
  'model.text': { delta: string };
  'model.reasoning': { delta: string };
  'model.completed': { usageNote?: string };

  'tool.started': { name: string; args?: string; planner?: string; phase?: string };
  'tool.completed': { name: string; preview?: string };

  'file.edit.proposed': {
    id: string;
    relPath: string;
    added: number;
    removed: number;
    isNewFile: boolean;
  };
  'file.edit.resolved': { id: string; decision: Decision };
  'file.edit.expired': { id: string };
  'file.locked': { filePath: string };
  'file.unlocked': { filePath: string };

  'command.proposed': {
    id: string;
    command: string;
    cwd: string;
    reason: string;
    autoRun: boolean;
  };
  'command.resolved': { id: string; decision: Decision };
  'command.finished': {
    id: string;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
    output: string;
  };
  'command.expired': { id: string };

  'context.attached': { label: string };
  notice: { message: string };
  error: { message: string };

  /** The planning phase as a whole. */
  'planning.started': { planners: string[]; count: number };
  'planning.completed': {
    plans: number;
    failed: number;
    files: number;
    changes: number;
    conflicts: number;
    confidence: number;
    proceed: boolean;
  };
  /** One planning agent. */
  'planning.agent.started': { planner: string; label: string; model: string };
  'planning.agent.completed': {
    planner: string;
    label: string;
    confidence: number;
    files: number;
    changes: number;
  };

  'verification.started': { attempt: number; model: string; files: number };
  'verification.completed': VerificationEventData;
  'verification.failed': VerificationEventData;

  'repair.started': { attempt: number; tasks: number };
  'repair.completed': { attempt: number; tasks: number };
}

export interface VerificationEventData {
  attempt: number;
  passed: boolean;
  tests: CheckOutcomeName;
  typecheck: CheckOutcomeName;
  lint: CheckOutcomeName;
  build: CheckOutcomeName;
  issues: number;
  fixes: number;
}

export type AgentEventType = keyof EventDataMap;

/** Every event type, for runtime validation and exhaustiveness tests. */
export const AGENT_EVENT_TYPES: readonly AgentEventType[] = [
  'task.created',
  'task.started',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'agent.created',
  'agent.started',
  'agent.state',
  'agent.completed',
  'agent.failed',
  'agent.cancelled',
  'model.started',
  'model.text',
  'model.reasoning',
  'model.completed',
  'tool.started',
  'tool.completed',
  'file.edit.proposed',
  'file.edit.resolved',
  'file.edit.expired',
  'file.locked',
  'file.unlocked',
  'command.proposed',
  'command.resolved',
  'command.finished',
  'command.expired',
  'context.attached',
  'notice',
  'error',
  'planning.started',
  'planning.completed',
  'planning.agent.started',
  'planning.agent.completed',
  'verification.started',
  'verification.completed',
  'verification.failed',
  'repair.started',
  'repair.completed'
];

export interface AgentEventOf<T extends AgentEventType> {
  eventId: EventId;
  eventVersion: string;
  /** The unit of work this belongs to. One chat turn is one task today. */
  taskId: TaskId;
  /** Absent for events the Coordinator itself raises. */
  agentId?: AgentId;
  /** Links a result back to what caused it, e.g. a tool result to its request. */
  parentEventId?: EventId;
  type: T;
  /** ISO 8601. */
  timestamp: string;
  /**
   * Monotonic across the whole bus, not per task. A single counter is what lets
   * the webview say "I have everything up to N" without tracking each task.
   */
  sequence: number;
  data: EventDataMap[T];
}

/** A discriminated union over every event type. */
export type AgentEvent = {
  [T in AgentEventType]: AgentEventOf<T>;
}[AgentEventType];

/** What `emit` is given; everything else is stamped by the bus. */
export type EmitOptions = {
  [T in AgentEventType]: {
    type: T;
    taskId: string;
    agentId?: string;
    parentEventId?: string;
  } & (EventDataMap[T] extends Record<string, never>
    ? { data?: EventDataMap[T] }
    : { data: EventDataMap[T] });
}[AgentEventType];

export interface ReplayResult {
  events: AgentEvent[];
  /**
   * True when the requested sequence had already been evicted from the buffer,
   * so the caller is missing events it can never receive. The UI must say so
   * rather than showing a silently incomplete run.
   */
  gap: boolean;
}
