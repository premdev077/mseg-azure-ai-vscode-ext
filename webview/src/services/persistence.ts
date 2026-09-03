import { logger } from './logger';
import { getVSCodeApi } from './vscode';

/**
 * The only state that survives a webview reload.
 *
 * VS Code disposes and recreates webviews freely; `localStorage` is not
 * reliable across that and brings CSP surprises, so the webview state API is
 * the supported route. Only the sequence cursor is kept — the transcript is
 * rehydrated from the host's event log, which is the source of truth.
 */
export interface PersistedState {
  lastSequence: number;
}

const EMPTY: PersistedState = { lastSequence: 0 };

export function readPersisted(): PersistedState {
  try {
    const saved = getVSCodeApi().getState();
    if (saved && typeof saved === 'object' && 'lastSequence' in saved) {
      const value = (saved as PersistedState).lastSequence;
      return typeof value === 'number' && Number.isFinite(value)
        ? { lastSequence: value }
        : EMPTY;
    }
    return EMPTY;
  } catch (error) {
    // A fresh webview has no state; anything else means the API is unavailable,
    // which degrades to "start from the beginning" rather than failing.
    logger.debug('No persisted webview state', { error: String(error) });
    return EMPTY;
  }
}

export function writePersisted(state: PersistedState): void {
  try {
    getVSCodeApi().setState(state);
  } catch (error) {
    logger.warn(
      'Could not persist webview state; a reload will replay from the start',
      {
        error: String(error)
      }
    );
  }
}
