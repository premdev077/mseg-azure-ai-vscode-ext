/**
 * Validation for messages arriving *from* the webview.
 *
 * The webview validates what the host sends it; this is the other half. A
 * webview is a browser context rendering model and tool output, so the host
 * must not let it drive privileged actions on the strength of an unchecked
 * field — a message that says `openFile` with a non-string path should be
 * dropped here, not discovered three frames deeper.
 *
 * Kept free of any `vscode` import so it can be tested in plain Node.
 */
export type WebviewMessage =
  | { type: 'ready'; lastSequence: number }
  | {
      type: 'send';
      text: string;
      model: string | undefined;
      mode: string | undefined;
      reasoningEffort: string | undefined;
      attachContext: boolean;
    }
  | { type: 'cancel' }
  | { type: 'newChat' }
  | { type: 'attach' }
  | { type: 'removeAttachment'; id: string }
  | { type: 'acceptEdit'; id: string }
  | { type: 'rejectEdit'; id: string }
  | { type: 'openDiff'; id: string }
  | { type: 'approveCommand'; id: string }
  | { type: 'rejectCommand'; id: string }
  | { type: 'openHistory' }
  | { type: 'closeHistory' }
  | { type: 'loadConversation'; id: string }
  | { type: 'deleteConversation'; id: string }
  | { type: 'openSettings' }
  | { type: 'setApiKey' }
  | { type: 'showReport' }
  | { type: 'openFile'; relPath: string }
  | { type: 'copy'; text: string }
  | { type: 'insertAtCursor'; text: string };

/** Messages that carry nothing beyond their name. */
const BARE_TYPES = [
  'cancel',
  'newChat',
  'attach',
  'openHistory',
  'closeHistory',
  'openSettings',
  'setApiKey',
  'showReport'
] as const;

/** Messages whose only payload is an id. */
const ID_TYPES = [
  'removeAttachment',
  'acceptEdit',
  'rejectEdit',
  'openDiff',
  'approveCommand',
  'rejectCommand',
  'loadConversation',
  'deleteConversation'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Narrows an inbound message, or returns undefined.
 *
 * Undefined means "drop it": there is no useful recovery from a message the
 * host cannot understand, and guessing at the intent of a malformed request to
 * write a file is exactly the wrong instinct.
 */
export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = str(value.type);
  if (type === undefined) {
    return undefined;
  }

  if ((BARE_TYPES as readonly string[]).includes(type)) {
    return { type } as WebviewMessage;
  }

  if ((ID_TYPES as readonly string[]).includes(type)) {
    const id = str(value.id);
    return id !== undefined && id.length > 0
      ? ({ type, id } as WebviewMessage)
      : undefined;
  }

  switch (type) {
    case 'ready': {
      const raw = value.lastSequence;
      const lastSequence =
        typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : 0;
      return { type, lastSequence };
    }

    case 'send': {
      const text = str(value.text);
      if (text === undefined) {
        return undefined;
      }
      return {
        type,
        text,
        model: str(value.model),
        mode: str(value.mode),
        reasoningEffort: str(value.reasoningEffort),
        // Defaults to on, matching the composer, so a missing field does not
        // silently drop the user's editor context.
        attachContext: value.attachContext !== false
      };
    }

    case 'openFile': {
      const relPath = str(value.relPath);
      return relPath !== undefined && relPath.length > 0
        ? { type, relPath }
        : undefined;
    }

    case 'copy':
    case 'insertAtCursor': {
      const text = str(value.text);
      return text !== undefined ? { type, text } : undefined;
    }

    default:
      return undefined;
  }
}
