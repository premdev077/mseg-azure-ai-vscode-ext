import type { AgentEvent } from '../../../../src/events/types';
import type { CommandView } from '../../types/view';

/** Shell commands awaiting approval, and their results. */
export interface CommandSliceState {
  readonly byId: Readonly<Record<string, CommandView>>;
  readonly ids: readonly string[];
}

export const initialCommandSlice: CommandSliceState = { byId: {}, ids: [] };

function patch(
  state: CommandSliceState,
  id: string,
  change: Partial<CommandView>
): CommandSliceState {
  const current = state.byId[id];
  if (!current) {
    return state;
  }
  return { ...state, byId: { ...state.byId, [id]: { ...current, ...change } } };
}

export function reduceCommands(
  state: CommandSliceState,
  event: AgentEvent
): CommandSliceState {
  switch (event.type) {
    case 'command.proposed': {
      const { id, command, cwd, reason, autoRun } = event.data;
      if (!id || state.byId[id]) {
        return state;
      }
      return {
        byId: {
          ...state.byId,
          [id]: {
            id,
            command,
            cwd,
            reason,
            autoRun,
            status: autoRun ? 'approved' : 'pending'
          }
        },
        ids: [...state.ids, id]
      };
    }

    case 'command.resolved':
      return patch(state, event.data.id, {
        status: event.data.decision === 'rejected' ? 'rejected' : 'approved'
      });

    case 'command.finished':
      return patch(state, event.data.id, {
        status: 'finished',
        exitCode: event.data.exitCode,
        durationMs: event.data.durationMs,
        output: event.data.output
      });

    case 'command.expired':
      return patch(state, event.data.id, { status: 'expired' });

    default:
      return state;
  }
}
