import type { AgentEvent, AgentId, NodeRole } from '../../../../src/events/types';
import { asAgentId } from '../../../../src/events/types';
import type { AgentStatus, AgentView } from '../../types/view';

/**
 * Agents, normalised.
 *
 * `byId` plus an ordered `ids` rather than an array of objects: a token
 * arriving for one agent must touch one entry, not rebuild a collection that
 * five components are subscribed to.
 */
export interface AgentSliceState {
  readonly byId: Readonly<Record<string, AgentView>>;
  readonly ids: readonly AgentId[];
}

export const initialAgentSlice: AgentSliceState = { byId: {}, ids: [] };

const ROLE_LABELS: Record<NodeRole, string> = {
  chat: 'Assistant',
  coordinator: 'Coordinator',
  planner: 'Planner',
  coder: 'Coder',
  verifier: 'Verification',
  repair: 'Repair'
};

/** Terminal agents ignore late updates; a finished agent does not resume. */
const TERMINAL: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'completed',
  'failed',
  'cancelled'
]);

function titleCase(value: string): string {
  const first = value.charAt(0);
  return first.length > 0 ? `${first.toUpperCase()}${value.slice(1)}` : value;
}

function upsert(
  state: AgentSliceState,
  id: AgentId,
  patch: Partial<AgentView>,
  seed: Partial<AgentView> = {}
): AgentSliceState {
  const existing = state.byId[id];

  if (existing && TERMINAL.has(existing.status) && patch.status === undefined) {
    // A settled agent still accepts a status change (cancel-all), but not a
    // stray progress update arriving after it finished.
    return state;
  }

  const next: AgentView = existing
    ? { ...existing, ...patch }
    : {
        id,
        role: 'agent',
        label: id,
        status: 'waiting',
        activity: '',
        files: [],
        tools: [],
        waitedOn: [],
        ...seed,
        ...patch
      };

  return {
    byId: { ...state.byId, [id]: next },
    ids: existing ? state.ids : [...state.ids, id]
  };
}

function withUnique(current: readonly string[], value: string): readonly string[] {
  return current.includes(value) ? current : [...current, value];
}

/**
 * Folds one event into agent state.
 *
 * Returns the same object when the event says nothing about agents, so the
 * store can skip a render rather than re-running selectors for a token.
 */
export function reduceAgents(
  state: AgentSliceState,
  event: AgentEvent
): AgentSliceState {
  switch (event.type) {
    case 'planning.started': {
      // Seed a card per planner up front so parallel work is visible as
      // parallel work, rather than appearing one at a time as each starts.
      return event.data.planners.reduce((acc, planner) => {
        const id = asAgentId(`plan-${planner}`);
        return acc.byId[id]
          ? acc
          : upsert(
              acc,
              id,
              {},
              {
                role: 'planner',
                label: titleCase(planner),
                status: 'waiting',
                activity: 'Queued'
              }
            );
      }, state);
    }

    case 'planning.agent.started': {
      if (!event.agentId) {
        return state;
      }
      return upsert(state, event.agentId, {
        role: 'planner',
        label: event.data.label,
        status: 'running',
        activity: 'Inspecting the repository',
        startedAt: Date.parse(event.timestamp)
      });
    }

    case 'planning.agent.completed': {
      if (!event.agentId) {
        return state;
      }
      return upsert(state, event.agentId, {
        status: 'completed',
        activity: `${event.data.changes} change(s) proposed`,
        finishedAt: Date.parse(event.timestamp)
      });
    }

    case 'agent.created': {
      const id = asAgentId(event.data.nodeId);
      return upsert(
        state,
        id,
        { waitedOn: event.data.waitedOn ?? [] },
        {
          role: event.data.role ?? 'agent',
          label: event.data.role ? ROLE_LABELS[event.data.role] : id,
          status: 'waiting',
          activity: 'Queued'
        }
      );
    }

    case 'agent.started': {
      if (!event.agentId) {
        return state;
      }
      const objective = event.data.objective ?? '';
      return upsert(
        state,
        event.agentId,
        {
          status: 'running',
          activity: objective.split('\n')[0] || 'Working',
          startedAt: Date.parse(event.timestamp)
        },
        {
          role: event.data.role ?? 'agent',
          label: event.data.role ? ROLE_LABELS[event.data.role] : event.agentId
        }
      );
    }

    case 'agent.completed': {
      const id =
        event.agentId ?? (event.data.nodeId ? asAgentId(event.data.nodeId) : undefined);
      return id
        ? upsert(state, id, {
            status: 'completed',
            activity: 'Done',
            finishedAt: Date.parse(event.timestamp)
          })
        : state;
    }

    case 'agent.failed': {
      const id =
        event.agentId ?? (event.data.nodeId ? asAgentId(event.data.nodeId) : undefined);
      return id
        ? upsert(state, id, {
            status: 'failed',
            activity: event.data.error ?? 'Failed',
            error: event.data.error,
            finishedAt: Date.parse(event.timestamp)
          })
        : state;
    }

    case 'agent.cancelled': {
      const id =
        event.agentId ?? (event.data.nodeId ? asAgentId(event.data.nodeId) : undefined);
      return id
        ? upsert(state, id, {
            status: 'cancelled',
            activity: 'Stopped',
            finishedAt: Date.parse(event.timestamp)
          })
        : state;
    }

    case 'task.cancelled': {
      // Everything unfinished stops; anything already settled keeps its result.
      const at = Date.parse(event.timestamp);
      let changed = false;
      const byId: Record<string, AgentView> = { ...state.byId };
      for (const id of state.ids) {
        const agent = byId[id];
        if (agent && !TERMINAL.has(agent.status)) {
          byId[id] = {
            ...agent,
            status: 'cancelled',
            activity: 'Stopped',
            finishedAt: at
          };
          changed = true;
        }
      }
      return changed ? { ...state, byId } : state;
    }

    case 'tool.started': {
      if (!event.agentId) {
        return state;
      }
      const agent = state.byId[event.agentId];
      if (!agent) {
        return state;
      }
      return upsert(state, event.agentId, {
        tools: withUnique(agent.tools, event.data.name)
      });
    }

    case 'file.edit.proposed': {
      if (!event.agentId) {
        return state;
      }
      const agent = state.byId[event.agentId];
      if (!agent) {
        return state;
      }
      return upsert(state, event.agentId, {
        files: withUnique(agent.files, event.data.relPath)
      });
    }

    default:
      return state;
  }
}

/** Sets the activity line from a tool description, without touching anything else. */
export function setAgentActivity(
  state: AgentSliceState,
  agentId: AgentId,
  activity: string
): AgentSliceState {
  const agent = state.byId[agentId];
  if (!agent || TERMINAL.has(agent.status)) {
    return state;
  }
  return {
    ...state,
    byId: { ...state.byId, [agentId]: { ...agent, activity } }
  };
}
