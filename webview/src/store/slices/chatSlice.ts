import type { AgentEvent } from '../../../../src/events/types';
import { MAX_MESSAGES } from '../../constants/limits';
import type { MessageView } from '../../types/view';

/**
 * The transcript.
 *
 * Streamed text appends to the trailing assistant message rather than creating
 * one per delta, and the list is capped so a long session cannot grow the DOM
 * without bound.
 */
export interface ChatSliceState {
  readonly messages: readonly MessageView[];
  readonly usageNote?: string | undefined;
}

export const initialChatSlice: ChatSliceState = { messages: [] };

function closeStreaming(messages: readonly MessageView[]): readonly MessageView[] {
  return messages.some((m) => m.streaming)
    ? messages.map((m) => (m.streaming ? { ...m, streaming: false } : m))
    : messages;
}

function trim(messages: readonly MessageView[]): readonly MessageView[] {
  return messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages;
}

export function reduceChat(state: ChatSliceState, event: AgentEvent): ChatSliceState {
  switch (event.type) {
    case 'model.text': {
      const delta = event.data.delta;
      if (!delta) {
        return state;
      }
      const last = state.messages[state.messages.length - 1];
      if (last && last.role === 'assistant' && last.streaming) {
        const messages = state.messages.slice();
        messages[messages.length - 1] = { ...last, text: last.text + delta };
        return { ...state, messages };
      }
      return {
        ...state,
        messages: trim([
          ...state.messages,
          {
            id: `m-${event.sequence}`,
            role: 'assistant',
            text: delta,
            streaming: true,
            at: Date.parse(event.timestamp)
          }
        ])
      };
    }

    case 'model.completed':
      return {
        messages: closeStreaming(state.messages),
        usageNote: event.data.usageNote ?? state.usageNote
      };

    case 'error':
    case 'task.cancelled':
    case 'task.failed':
      return { ...state, messages: closeStreaming(state.messages) };

    default:
      return state;
  }
}

/** A user message originates in the UI, not from an event. */
export function appendUserMessage(
  state: ChatSliceState,
  text: string,
  at: number
): ChatSliceState {
  return {
    ...state,
    messages: trim([
      ...state.messages,
      {
        id: `u-${at}-${state.messages.length}`,
        role: 'user',
        text,
        streaming: false,
        at
      }
    ])
  };
}

/** Replaces the transcript when a stored conversation is reopened. */
export function replaceMessages(
  state: ChatSliceState,
  messages: readonly MessageView[]
): ChatSliceState {
  return { ...state, messages: trim(messages) };
}
