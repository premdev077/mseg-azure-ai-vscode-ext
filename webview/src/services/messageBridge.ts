import { logger, logOnce } from './logger';
import {
  isUnknownEventType,
  parseAgentEvent,
  parseAttachments,
  parseConversations,
  parsePrefill,
  parseStatus,
  parseTurns
} from './protocol';
import { readPersisted, writePersisted } from './persistence';
import { host } from './vscode';
import { useAppStore } from '../store/appStore';

/**
 * Inbound dispatch: host messages become validated state changes.
 *
 * Every message is parsed before it reaches the store. A malformed one is
 * counted and dropped — the peer is another process on its own release
 * cadence, and a panel that throws on an unexpected field is a panel that
 * breaks on every upgrade.
 */

/** Fired when the host pre-fills the composer, e.g. from "Explain Selection". */
export const PREFILL_EVENT = 'azure-ai:prefill';

export interface PrefillDetail {
  text: string;
  autosend: boolean;
}

function handle(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) {
    return;
  }
  const message = raw as Record<string, unknown>;
  const store = useAppStore.getState();

  switch (message.type) {
    case 'event': {
      const event = parseAgentEvent(message.event);
      if (!event) {
        if (isUnknownEventType(message.event)) {
          // Forward compatibility: a newer host knows an event type we do not.
          // Ignore it and say so once, rather than per occurrence.
          logOnce(
            `unknown-event-${String((message.event as { type?: string })?.type)}`,
            'info',
            'Ignoring an event type this build does not know',
            { type: (message.event as { type?: string })?.type }
          );
        } else {
          logger.warn('Dropped a malformed event from the extension host');
        }
        return;
      }
      writePersisted({ lastSequence: event.sequence });
      store.push(event);
      break;
    }

    case 'replay': {
      const raw = Array.isArray(message.events) ? message.events : [];
      store.setConnection('catching-up');

      let applied = 0;
      let highest = 0;
      for (const candidate of raw) {
        const event = parseAgentEvent(candidate);
        if (!event) {
          continue;
        }
        applied += 1;
        highest = Math.max(highest, event.sequence);
        store.push(event);
      }
      if (highest > 0) {
        writePersisted({ lastSequence: highest });
      }
      logger.debug('Replayed missed activity', { applied, received: raw.length });
      store.setConnection(message.gap === true ? 'degraded' : 'live');
      break;
    }

    case 'status': {
      const status = parseStatus(message);
      if (status) {
        store.setStatus(status);
        store.setConnection('live');
      }
      break;
    }

    case 'attachments':
      store.setAttachments(parseAttachments(message.items));
      break;

    case 'attachmentsCleared':
      store.setAttachments([]);
      break;

    case 'history':
      store.setConversations(parseConversations(message.items));
      store.setHistoryOpen(true);
      break;

    case 'cleared':
      writePersisted({ lastSequence: 0 });
      store.reset();
      break;

    case 'restore':
      // A stored conversation arrives as turns rather than events, so it
      // replaces the transcript instead of folding through the reducer.
      writePersisted({ lastSequence: 0 });
      store.restore(parseTurns(message.turns));
      store.setHistoryOpen(false);
      break;

    case 'prefill': {
      const detail = parsePrefill(message);
      if (detail) {
        window.dispatchEvent(new CustomEvent<PrefillDetail>(PREFILL_EVENT, { detail }));
      }
      break;
    }

    default:
      // Unknown message types are the host being newer than the webview.
      logOnce(
        `unknown-message-${String(message.type)}`,
        'debug',
        'Ignoring an unknown host message',
        {
          type: message.type
        }
      );
      break;
  }
}

/**
 * Starts listening and announces readiness.
 *
 * The handshake carries the last sequence this view applied. A webview that
 * was torn down and rebuilt has an empty transcript, so it asks for everything
 * (sequence 0) and rebuilds from the host's log; one that merely reconnected
 * asks only for the gap.
 */
export function connectToHost(): () => void {
  const onMessage = (event: MessageEvent): void => {
    try {
      handle(event.data);
    } catch (error) {
      // A bad message must never take the panel down with it.
      logger.error('Failed to handle a host message', { error: String(error) });
    }
  };

  window.addEventListener('message', onMessage);
  useAppStore.getState().setConnection('connecting');

  // React state does not survive a webview reload; only `setState` does. So a
  // remembered sequence with an empty store would leave the transcript
  // permanently missing everything before the reload. Ask for the whole log
  // and let dedupe handle the overlap.
  const persisted = readPersisted();
  const isFreshView = useAppStore.getState().app.chat.messages.length === 0;
  host.ready(isFreshView ? 0 : persisted.lastSequence);

  return () => window.removeEventListener('message', onMessage);
}
