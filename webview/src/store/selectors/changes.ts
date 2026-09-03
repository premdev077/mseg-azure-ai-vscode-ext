import type { ChangeView } from '../../types/view';
import type { AppState } from '../processEvent';

export const EMPTY_CHANGES: readonly ChangeView[] = [];

export function selectChanges(state: AppState): readonly ChangeView[] {
  const { byPath, paths } = state.changes;
  if (paths.length === 0) {
    return EMPTY_CHANGES;
  }
  return paths
    .map((path) => byPath[path])
    .filter((change): change is ChangeView => change !== undefined);
}

/** Only what reached disk. A rejected edit changed nothing and must not count. */
export function selectChangeSummary(state: AppState): {
  files: number;
  added: number;
  removed: number;
} {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const path of state.changes.paths) {
    const change = state.changes.byPath[path];
    if (change?.status === 'accepted') {
      files += 1;
      added += change.added;
      removed += change.removed;
    }
  }
  return { files, added, removed };
}
