import {
  AGENT_EVENT_TYPES,
  type AgentEvent,
  type AgentEventType,
  asAgentId,
  asEventId,
  asTaskId
} from '../../../src/events/types';
import type { MessageView } from '../types/view';

/**
 * The extension↔webview boundary, treated as untrusted on both sides.
 *
 * Everything here is a runtime guard rather than a cast. A cast tells the
 * compiler what we hope arrived; a guard establishes what actually did. The
 * peer is another process whose version may not match ours, so a malformed
 * message is logged and dropped — it never throws into React.
 */

const EVENT_TYPES = new Set<string>(AGENT_EVENT_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

/**
 * Validates the envelope only.
 *
 * `data` is checked per type by the slices, which narrow it through the
 * discriminated union — re-validating every payload field here would duplicate
 * the type map and drift from it. What matters at the boundary is that the
 * envelope is well formed and the type is one we know.
 */
export function parseAgentEvent(value: unknown): AgentEvent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { eventId, eventVersion, taskId, type, timestamp, sequence, data } = value;

  if (!isString(eventId) || eventId.length === 0) {
    return undefined;
  }
  if (!isString(eventVersion)) {
    return undefined;
  }
  if (!isString(taskId) || taskId.length === 0) {
    return undefined;
  }
  if (!isString(type) || !EVENT_TYPES.has(type)) {
    // Forward compatibility: a newer host may emit a type we do not know. The
    // caller counts and ignores it rather than treating it as corruption.
    return undefined;
  }
  if (!isString(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    return undefined;
  }
  if (!isFiniteNumber(sequence)) {
    return undefined;
  }
  if (!isRecord(data)) {
    return undefined;
  }

  const agentId = value.agentId;
  const parentEventId = value.parentEventId;

  return {
    eventId: asEventId(eventId),
    eventVersion,
    taskId: asTaskId(taskId),
    agentId: isString(agentId) ? asAgentId(agentId) : undefined,
    parentEventId: isString(parentEventId) ? asEventId(parentEventId) : undefined,
    type: type as AgentEventType,
    timestamp,
    sequence,
    data
    // The envelope is verified above; `data` is narrowed per type by the
    // slices, which is where the type map already lives.
  } as AgentEvent;
}

/** True when the value looks like an event but names a type we do not know. */
export function isUnknownEventType(value: unknown): boolean {
  return isRecord(value) && isString(value.type) && !EVENT_TYPES.has(value.type);
}

/* ------------------------------------------------------------ host → webview */

export interface HostStatus {
  configured: boolean;
  endpoint: string;
  models: string[];
  modes: Array<{ mode: string; label: string; description: string }>;
  defaultMode: string;
  defaultEffort: string;
  orchestration: string;
  autoApprove: boolean;
}

export interface AttachmentView {
  id: string;
  name: string;
  kind: string;
  size: string;
  note?: string | undefined;
  error?: string | undefined;
}

export interface ConversationView {
  id: string;
  title: string;
  updatedAt: string;
  workspace?: string | undefined;
}

export function parseStatus(value: unknown): HostStatus | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const modes = Array.isArray(value.modes)
    ? value.modes.filter(isRecord).map((m) => ({
        mode: isString(m.mode) ? m.mode : '',
        label: isString(m.label) ? m.label : '',
        description: isString(m.description) ? m.description : ''
      }))
    : [];

  return {
    configured: value.configured === true,
    endpoint: isString(value.endpoint) ? value.endpoint : '',
    models: stringArray(value.models),
    modes: modes.filter((m) => m.mode.length > 0),
    defaultMode: isString(value.defaultMode) ? value.defaultMode : '',
    defaultEffort: isString(value.defaultEffort) ? value.defaultEffort : '',
    orchestration: isString(value.orchestration) ? value.orchestration : 'single',
    autoApprove: value.autoApprove === true
  };
}

export function parseAttachments(value: unknown): AttachmentView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).flatMap((item) => {
    if (!isString(item.id) || !isString(item.name)) {
      return [];
    }
    return [
      {
        id: item.id,
        name: item.name,
        kind: isString(item.kind) ? item.kind : 'file',
        size: isString(item.size) ? item.size : '',
        note: isString(item.note) ? item.note : undefined,
        error: isString(item.error) ? item.error : undefined
      }
    ];
  });
}

export function parseConversations(value: unknown): ConversationView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).flatMap((item) => {
    if (!isString(item.id)) {
      return [];
    }
    return [
      {
        id: item.id,
        title: isString(item.title) ? item.title : 'Untitled',
        updatedAt: isString(item.updatedAt) ? item.updatedAt : new Date().toISOString(),
        workspace: isString(item.workspace) ? item.workspace : undefined
      }
    ];
  });
}

/** A stored conversation arrives as plain turns, not as events. */
export function parseTurns(value: unknown): MessageView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).flatMap((turn, index) => {
    const role = turn.role;
    if (role !== 'user' && role !== 'assistant') {
      return [];
    }
    return [
      {
        id: `restored-${index}`,
        role,
        text: isString(turn.text) ? turn.text : '',
        streaming: false,
        at: Date.now()
      }
    ];
  });
}

export function parsePrefill(
  value: unknown
): { text: string; autosend: boolean } | undefined {
  if (!isRecord(value) || !isString(value.text)) {
    return undefined;
  }
  return { text: value.text, autosend: value.autosend === true };
}
