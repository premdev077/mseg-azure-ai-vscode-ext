import type { CommandView } from '../../types/view';
import type { AppState } from '../processEvent';

export const EMPTY_COMMANDS: readonly CommandView[] = [];

/** Expired commands are noise once they can no longer be acted on. */
export function selectVisibleCommands(state: AppState): readonly CommandView[] {
  const visible = state.commands.ids
    .map((id) => state.commands.byId[id])
    .filter((cmd): cmd is CommandView => cmd !== undefined && cmd.status !== 'expired');
  return visible.length === 0 ? EMPTY_COMMANDS : visible;
}
