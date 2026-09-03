/**
 * The agent's observable state.
 *
 * The loop already had a `running` boolean; this replaces it with something the
 * UI can narrate, because the agent panel renders operational progress and
 * "editing" reads very differently from "testing" when a turn is taking a
 * while. It is deliberately derived from what the loop actually does — no state
 * exists here that nothing sets.
 */
export type AgentState =
  | 'idle'
  | 'analyzing'
  | 'planning'
  | 'searching'
  | 'reading'
  | 'editing'
  | 'testing'
  | 'fixing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** States in which a turn is still doing work. */
const ACTIVE: ReadonlySet<AgentState> = new Set<AgentState>([
  'analyzing',
  'planning',
  'searching',
  'reading',
  'editing',
  'testing',
  'fixing'
]);

export function isActive(state: AgentState): boolean {
  return ACTIVE.has(state);
}

/**
 * The state a tool call puts the agent in. Keeps the mapping in one place so
 * the loop does not grow a switch, and an unknown tool degrades to
 * 'analyzing' rather than lying about what is happening.
 */
const TOOL_STATE: Readonly<Record<string, AgentState>> = {
  read_file: 'reading',
  list_files: 'searching',
  search_workspace: 'searching',
  get_file_symbols: 'reading',
  find_references: 'searching',
  find_definition: 'searching',
  project_structure: 'searching',
  write_file: 'editing',
  apply_patch: 'editing',
  run_validation: 'testing',
  get_diagnostics: 'testing',
  run_command: 'testing',
  git_status: 'analyzing',
  git_diff: 'analyzing',
  record_session: 'analyzing'
};

export function stateForTool(toolName: string): AgentState {
  return TOOL_STATE[toolName] ?? 'analyzing';
}

/** Human-readable label, used by the panel and the session report. */
export function describeState(state: AgentState): string {
  switch (state) {
    case 'idle':
      return 'Idle';
    case 'analyzing':
      return 'Analyzing';
    case 'planning':
      return 'Planning';
    case 'searching':
      return 'Searching the workspace';
    case 'reading':
      return 'Reading files';
    case 'editing':
      return 'Preparing changes';
    case 'testing':
      return 'Running checks';
    case 'fixing':
      return 'Fixing failures';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Stopped';
  }
}
