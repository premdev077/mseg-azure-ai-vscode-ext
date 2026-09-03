import { create } from 'zustand';
import type { AgentEvent } from '../../../src/events/types';
import type {
  AttachmentView,
  ConversationView,
  HostStatus
} from '../services/protocol';
import type { ConnectionState, MessageView } from '../types/view';
import {
  addUserMessage,
  connectionChanged,
  dismiss,
  initialAppState,
  processEvents,
  resetAppState,
  restoreMessages,
  type AppState
} from './processEvent';

/**
 * One store, composed of domain slices.
 *
 * The standard asks for domain stores rather than a god store, and for a
 * single event pipeline. Slices in one store satisfy both: each domain owns
 * its shape and its fold, while `processEvent` remains the only path from an
 * event to state — two independent stores subscribing to the same stream is
 * how the panels start disagreeing.
 */
interface StoreState {
  app: AppState;
  /** Host-owned data that arrives as plumbing rather than as events. */
  status: HostStatus | null;
  attachments: readonly AttachmentView[];
  conversations: readonly ConversationView[];
  historyOpen: boolean;
  /** True between asking the host for history and its reply arriving. */
  historyLoading: boolean;

  push(event: AgentEvent): void;
  flush(): void;
  setConnection(connection: ConnectionState): void;
  setStatus(status: HostStatus): void;
  setAttachments(items: readonly AttachmentView[]): void;
  setConversations(items: readonly ConversationView[]): void;
  requestHistory(): void;
  setHistoryOpen(open: boolean): void;
  addUserMessage(text: string): void;
  restore(messages: readonly MessageView[]): void;
  dismissNotice(id: string): void;
  reset(): void;
}

/**
 * Events arrive one per streamed token. Folding each one immediately would
 * re-render the tree hundreds of times a second with several agents running,
 * so they buffer and apply once per animation frame — one render per frame
 * whether ten events or three hundred arrived in it.
 */
let queue: AgentEvent[] = [];
let frame: number | undefined;

export const useAppStore = create<StoreState>((set, get) => ({
  app: initialAppState,
  status: null,
  attachments: [],
  conversations: [],
  historyOpen: false,
  historyLoading: false,

  push(event) {
    queue.push(event);
    if (frame !== undefined) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = undefined;
      get().flush();
    });
  },

  flush() {
    const batch = queue;
    queue = [];
    if (batch.length === 0) {
      return;
    }
    const before = get().app;
    const after = processEvents(before, batch);
    // An unchanged reference means no panel displays anything in this batch,
    // so there is nothing to re-render.
    if (after !== before) {
      set({ app: after });
    }
  },

  setConnection: (connection) =>
    set((s) => ({ app: connectionChanged(s.app, connection) })),
  setStatus: (status) => set({ status }),
  setAttachments: (attachments) => set({ attachments }),
  setConversations: (conversations) => set({ conversations, historyLoading: false }),
  requestHistory: () => set({ historyOpen: true, historyLoading: true }),
  setHistoryOpen: (historyOpen) => set({ historyOpen }),

  addUserMessage: (text) =>
    set((s) => ({ app: addUserMessage(s.app, text, Date.now()) })),

  restore: (messages) => set({ app: restoreMessages(messages) }),

  dismissNotice: (id) => set((s) => ({ app: dismiss(s.app, id) })),

  reset: () =>
    set({
      app: resetAppState(),
      attachments: [],
      historyOpen: false,
      historyLoading: false
    })
}));
