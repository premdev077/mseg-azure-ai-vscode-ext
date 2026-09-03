import type { AgentEvent } from '../../../../src/events/types';
import type { ChangeView } from '../../types/view';

/**
 * Files the run proposed changing, keyed by path.
 *
 * Rejected and expired entries are kept rather than removed: "this was
 * proposed and you said no" is information, and a list that silently drops
 * them makes a rejected edit look like it never happened.
 */
export interface ChangeSliceState {
  readonly byPath: Readonly<Record<string, ChangeView>>;
  readonly paths: readonly string[];
}

export const initialChangeSlice: ChangeSliceState = { byPath: {}, paths: [] };

export function reduceChanges(
  state: ChangeSliceState,
  event: AgentEvent
): ChangeSliceState {
  switch (event.type) {
    case 'file.edit.proposed': {
      const { id, relPath, added, removed, isNewFile } = event.data;
      if (!relPath) {
        return state;
      }
      const entry: ChangeView = {
        relPath,
        added,
        removed,
        isNewFile,
        // An auto-applied edit never goes to review, so it is already on disk.
        status: id === 'auto' ? 'accepted' : 'proposed',
        editId: id || undefined
      };
      return {
        byPath: { ...state.byPath, [relPath]: entry },
        paths: state.byPath[relPath] ? state.paths : [...state.paths, relPath]
      };
    }

    case 'file.edit.resolved': {
      const path = state.paths.find((p) => state.byPath[p]?.editId === event.data.id);
      if (!path) {
        return state;
      }
      const current = state.byPath[path];
      if (!current) {
        return state;
      }
      return {
        ...state,
        byPath: {
          ...state.byPath,
          [path]: {
            ...current,
            status: event.data.decision === 'rejected' ? 'rejected' : 'accepted'
          }
        }
      };
    }

    case 'file.edit.expired': {
      const path = state.paths.find((p) => state.byPath[p]?.editId === event.data.id);
      const current = path ? state.byPath[path] : undefined;
      if (!path || !current) {
        return state;
      }
      return {
        ...state,
        byPath: { ...state.byPath, [path]: { ...current, status: 'expired' } }
      };
    }

    default:
      return state;
  }
}
