import type { AgentView } from '../../types/view';
import type { AppState } from '../processEvent';

/**
 * Derived agent views.
 *
 * Kept out of components and out of the slices: a component that computes
 * "how many are running" during render recomputes it on every token, and a
 * slice that stores it has two sources of truth to keep in step.
 *
 * Module-level constants so an empty result is referentially stable and does
 * not re-render every subscriber.
 */
export const EMPTY_AGENTS: readonly AgentView[] = [];

const ROLE_ORDER: Record<string, number> = {
  coordinator: 0,
  planner: 1,
  coder: 2,
  repair: 3,
  verifier: 4,
  chat: 5
};

/**
 * Agents grouped by role so the phases read top to bottom, and stable within a
 * role so rows do not jump as agents finish.
 */
export function selectOrderedAgents(state: AppState): readonly AgentView[] {
  const { byId, ids } = state.agents;
  if (ids.length === 0) {
    return EMPTY_AGENTS;
  }
  return ids
    .map((id) => byId[id])
    .filter((agent): agent is AgentView => agent !== undefined)
    .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
}

export function selectAgentCounts(state: AppState): {
  total: number;
  running: number;
  done: number;
} {
  let running = 0;
  let done = 0;
  for (const id of state.agents.ids) {
    const status = state.agents.byId[id]?.status;
    if (status === 'running') {
      running += 1;
    } else if (status === 'completed') {
      done += 1;
    }
  }
  return { total: state.agents.ids.length, running, done };
}
