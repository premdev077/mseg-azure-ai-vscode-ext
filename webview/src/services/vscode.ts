/**
 * The message bridge — the only module that touches the VS Code webview API.
 *
 * `acquireVsCodeApi()` may be called exactly once per webview, so it is called
 * here and nowhere else. Components import `host`, never this transport, which
 * is what keeps the UI ignorant of how the extension is reached and lets tests
 * substitute a fake.
 */
export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

/**
 * Outside a webview — a unit test, a story — there is no API to acquire, so
 * this degrades to a recording stub rather than throwing at import time.
 */
function createFallback(): VsCodeApi {
  let state: unknown;
  return {
    postMessage: () => undefined,
    getState: () => state,
    setState: (next) => {
      state = next;
    }
  };
}

export function getVSCodeApi(): VsCodeApi {
  if (!api) {
    api =
      typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : createFallback();
  }
  return api;
}

/**
 * Messages the webview sends. A closed union so a typo is a compile error
 * rather than a message the host silently ignores.
 */
export type WebviewToHost =
  | { type: 'ready'; lastSequence: number }
  | {
      type: 'send';
      text: string;
      model: string;
      mode: string;
      reasoningEffort: string;
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

function send(message: WebviewToHost): void {
  getVSCodeApi().postMessage(message);
}

/**
 * What the UI can ask the extension to do.
 *
 * Named by intent rather than by transport, so a component reads as
 * `host.acceptEdit(id)` rather than assembling a message shape.
 */
export const host = {
  ready: (lastSequence: number) => send({ type: 'ready', lastSequence }),
  send: (payload: Omit<Extract<WebviewToHost, { type: 'send' }>, 'type'>) =>
    send({ type: 'send', ...payload }),
  cancel: () => send({ type: 'cancel' }),
  newChat: () => send({ type: 'newChat' }),
  attach: () => send({ type: 'attach' }),
  removeAttachment: (id: string) => send({ type: 'removeAttachment', id }),
  acceptEdit: (id: string) => send({ type: 'acceptEdit', id }),
  rejectEdit: (id: string) => send({ type: 'rejectEdit', id }),
  openDiff: (id: string) => send({ type: 'openDiff', id }),
  approveCommand: (id: string) => send({ type: 'approveCommand', id }),
  rejectCommand: (id: string) => send({ type: 'rejectCommand', id }),
  openHistory: () => send({ type: 'openHistory' }),
  closeHistory: () => send({ type: 'closeHistory' }),
  loadConversation: (id: string) => send({ type: 'loadConversation', id }),
  deleteConversation: (id: string) => send({ type: 'deleteConversation', id }),
  openSettings: () => send({ type: 'openSettings' }),
  setApiKey: () => send({ type: 'setApiKey' }),
  showReport: () => send({ type: 'showReport' }),
  openFile: (relPath: string) => send({ type: 'openFile', relPath }),
  copy: (text: string) => send({ type: 'copy', text }),
  insertAtCursor: (text: string) => send({ type: 'insertAtCursor', text })
};
