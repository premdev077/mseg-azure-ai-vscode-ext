import type { AgentEvent } from '../../../src/events/types';
import { EVENT_VERSION } from '../../../src/events/types';
import { MAX_SEEN_EVENTS } from '../constants/limits';
import type { ConnectionState } from '../types/view';
import {
  initialAgentSlice,
  reduceAgents,
  setAgentActivity,
  type AgentSliceState
} from './slices/agentSlice';
import {
  appendUserMessage,
  initialChatSlice,
  reduceChat,
  replaceMessages,
  type ChatSliceState
} from './slices/chatSlice';
import {
  initialChangeSlice,
  reduceChanges,
  type ChangeSliceState
} from './slices/changeSlice';
import {
  initialCommandSlice,
  reduceCommands,
  type CommandSliceState
} from './slices/commandSlice';
import {
  describeTool,
  dismissNotice,
  initialStreamSlice,
  reduceStream,
  setConnection,
  type StreamSliceState
} from './slices/streamSlice';
import {
  initialVerificationSlice,
  reduceVerification,
  type VerificationSliceState
} from './slices/verificationSlice';
import type { MessageView } from '../types/view';

/**
 * The one place events become state.
 *
 * Everything the standard requires of an event reducer lives here rather than
 * in the slices, so each slice stays a plain fold and the cross-cutting
 * concerns — duplicates, ordering, unknown types, version skew — have exactly
 * one implementation.
 */
export interface AppState {
  readonly agents: AgentSliceState;
  readonly chat: ChatSliceState;
  readonly changes: ChangeSliceState;
  readonly commands: CommandSliceState;
  readonly stream: StreamSliceState;
  readonly verification: VerificationSliceState;
  /**
   * Event ids already applied. Replays overlap by design, so this is the
   * difference between catching up and rendering the same tokens twice.
   */
  readonly seen: ReadonlySet<string>;
}

export const initialAppState: AppState = {
  agents: initialAgentSlice,
  chat: initialChatSlice,
  changes: initialChangeSlice,
  commands: initialCommandSlice,
  stream: initialStreamSlice,
  verification: initialVerificationSlice,
  seen: new Set()
};

/**
 * Remembers an event id, forgetting the oldest once the set is full.
 *
 * Bounded because a long run emits tens of thousands of events and an
 * unbounded dedupe set is a memory leak that only shows up in long sessions.
 */
function remember(seen: ReadonlySet<string>, eventId: string): ReadonlySet<string> {
  if (seen.size < MAX_SEEN_EVENTS) {
    const next = new Set(seen);
    next.add(eventId);
    return next;
  }
  // Drop the oldest quarter in one pass rather than one id per event.
  const keep = [...seen].slice(Math.floor(MAX_SEEN_EVENTS / 4));
  keep.push(eventId);
  return new Set(keep);
}

/**
 * Folds one event in.
 *
 * Returns the *same* object when nothing changed, which is what lets the store
 * skip a render for an event no panel displays.
 */
export function processEvent(state: AppState, event: AgentEvent): AppState {
  // Idempotency: reconnects and reloads replay, so a duplicate is expected
  // rather than exceptional. Applying one twice would double-append tokens.
  if (state.seen.has(event.eventId)) {
    return {
      ...state,
      stream: { ...state.stream, duplicateEvents: state.stream.duplicateEvents + 1 }
    };
  }

  // Version skew: apply the fields we understand and carry on. Refusing an
  // event because a newer host added a field would break the panel on upgrade.
  const skewed = event.eventVersion !== EVENT_VERSION;

  let agents = reduceAgents(state.agents, event);

  // The activity line is derived from the tool description, which belongs to
  // the stream vocabulary rather than the agent slice.
  if (event.type === 'tool.started' && event.agentId) {
    agents = setAgentActivity(
      agents,
      event.agentId,
      describeTool(event.data.name, event.data.args ?? '')
    );
  }

  const next: AppState = {
    agents,
    chat: reduceChat(state.chat, event),
    changes: reduceChanges(state.changes, event),
    commands: reduceCommands(state.commands, event),
    stream: reduceStream(
      skewed
        ? { ...state.stream, droppedEvents: state.stream.droppedEvents }
        : state.stream,
      event
    ),
    verification: reduceVerification(state.verification, event),
    seen: remember(state.seen, event.eventId)
  };

  return next;
}

/** Applies a batch in order. Used by the store's frame flush. */
export function processEvents(
  state: AppState,
  events: readonly AgentEvent[]
): AppState {
  // Sorting by sequence handles the out-of-order arrivals a batched flush can
  // produce; duplicates are then dropped by `processEvent`.
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  return ordered.reduce(processEvent, state);
}

/* ------------------------------------------------------------ UI-origin ops */

export function addUserMessage(state: AppState, text: string, at: number): AppState {
  return {
    ...state,
    chat: appendUserMessage(state.chat, text, at),
    stream: { ...state.stream, busy: true, contextLabels: [] }
  };
}

/**
 * Reopening a stored conversation replaces everything.
 *
 * The previous run's agents, changes and verdict do not belong to the
 * conversation being opened, so none of the old state is carried over.
 */
export function restoreMessages(messages: readonly MessageView[]): AppState {
  return { ...initialAppState, chat: replaceMessages(initialChatSlice, messages) };
}

export function dismiss(state: AppState, noticeId: string): AppState {
  return { ...state, stream: dismissNotice(state.stream, noticeId) };
}

export function connectionChanged(
  state: AppState,
  connection: ConnectionState
): AppState {
  const stream = setConnection(state.stream, connection);
  return stream === state.stream ? state : { ...state, stream };
}

/**
 * Resets for a new conversation.
 *
 * `seen` is cleared with everything else: sequence numbers keep climbing on
 * the host, so ids from the previous task can never collide with the next.
 */
export function resetAppState(): AppState {
  return { ...initialAppState, seen: new Set() };
}
