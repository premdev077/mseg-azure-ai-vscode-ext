import type { AgentEvent } from '../../../../src/events/types';
import { MAX_NOTICES, MAX_TOOL_HISTORY } from '../../constants/limits';
import type {
  ConnectionState,
  NoticeView,
  TaskPhase,
  ToolView
} from '../../types/view';

/**
 * The run itself: what phase it is in, what it is doing, what it is telling
 * the user, and how the stream is behaving.
 */
export interface StreamSliceState {
  readonly taskId?: string | undefined;
  readonly phase: TaskPhase;
  /** Safe progress text for the header. Never private reasoning. */
  readonly phaseLabel: string;
  readonly busy: boolean;
  readonly connection: ConnectionState;
  readonly tools: readonly ToolView[];
  readonly notices: readonly NoticeView[];
  readonly contextLabels: readonly string[];
  readonly lastSequence: number;
  /** Counters a diagnostics view can show when a stream misbehaves. */
  readonly droppedEvents: number;
  readonly duplicateEvents: number;
}

export const initialStreamSlice: StreamSliceState = {
  phase: 'idle',
  phaseLabel: 'Ready',
  busy: false,
  connection: 'connecting',
  tools: [],
  notices: [],
  contextLabels: [],
  lastSequence: 0,
  droppedEvents: 0,
  duplicateEvents: 0
};

/** A short, safe description of a tool call: process, never reasoning. */
export function describeTool(name: string, args: string): string {
  switch (name) {
    case 'read_file':
      return args ? `Reading ${args}` : 'Reading a file';
    case 'list_files':
      return args ? `Listing ${args}` : 'Listing files';
    case 'search_workspace':
      return args ? `Searching for ${args}` : 'Searching the workspace';
    case 'apply_patch':
      return args ? `Patching ${args}` : 'Preparing a patch';
    case 'write_file':
      return args ? `Writing ${args}` : 'Preparing a file';
    case 'get_diagnostics':
      return 'Checking problems';
    case 'run_validation':
      return 'Running project checks';
    case 'run_command':
      return args ? `Running ${args}` : 'Running a command';
    case 'git_status':
      return 'Checking git status';
    case 'git_diff':
      return 'Reviewing the diff';
    case 'record_session':
      return 'Recording context';
    case 'submit_plan':
      return 'Submitting its plan';
    case 'submit_verification':
      return 'Submitting the verdict';
    default:
      return name.replace(/_/g, ' ');
  }
}

function withNotice(
  state: StreamSliceState,
  text: string,
  kind: NoticeView['kind'],
  id: string
): readonly NoticeView[] {
  return [...state.notices.slice(-(MAX_NOTICES - 1)), { id, text, kind }];
}

export function reduceStream(
  state: StreamSliceState,
  event: AgentEvent
): StreamSliceState {
  const base: StreamSliceState = {
    ...state,
    taskId: event.taskId,
    lastSequence: Math.max(state.lastSequence, event.sequence)
  };

  switch (event.type) {
    case 'task.started':
      return { ...base, busy: true, phase: 'planning', phaseLabel: 'Starting' };

    case 'task.completed':
      return { ...base, busy: false, phase: 'completed', phaseLabel: 'Completed' };

    case 'task.failed':
      return { ...base, busy: false, phase: 'failed', phaseLabel: 'Failed' };

    case 'task.cancelled':
      return { ...base, busy: false, phase: 'cancelled', phaseLabel: 'Stopped' };

    case 'planning.started':
      return { ...base, busy: true, phase: 'planning', phaseLabel: 'Planning' };

    case 'planning.completed':
      return { ...base, phase: 'implementing', phaseLabel: 'Implementing' };

    case 'verification.started':
      return { ...base, busy: true, phase: 'verifying', phaseLabel: 'Verifying' };

    case 'verification.completed':
    case 'verification.failed':
      return {
        ...base,
        phase: event.data.passed ? 'completed' : base.phase,
        phaseLabel: event.data.passed ? 'Verified' : 'Not verified'
      };

    case 'repair.started':
      return {
        ...base,
        busy: true,
        phase: 'repairing',
        phaseLabel: `Repairing (attempt ${event.data.attempt})`
      };

    case 'agent.state': {
      const terminal =
        event.data.state === 'completed' ||
        event.data.state === 'failed' ||
        event.data.state === 'cancelled' ||
        event.data.state === 'idle';
      return {
        ...base,
        phaseLabel: event.data.label || base.phaseLabel,
        busy: terminal ? false : base.busy
      };
    }

    case 'model.started':
      return { ...base, busy: true };

    case 'model.reasoning':
      // The deployment's own summary only signals that thinking is happening.
      // The text itself is never stored or rendered.
      return { ...base, phaseLabel: 'Thinking' };

    case 'model.completed':
      return { ...base, busy: false };

    case 'tool.started':
      return {
        ...base,
        tools: [
          ...state.tools.slice(-(MAX_TOOL_HISTORY - 1)),
          {
            id: `t-${event.sequence}`,
            agentId: event.agentId,
            name: event.data.name,
            args: event.data.args ?? '',
            status: 'running',
            at: Date.parse(event.timestamp)
          }
        ]
      };

    case 'tool.completed': {
      const preview = event.data.preview ?? '';
      // Match the most recent running call of the same name: calls are issued
      // and answered in order per agent, and ids are not echoed back.
      const match = state.tools
        .map((tool, index) => ({ tool, index }))
        .filter((e) => e.tool.name === event.data.name && e.tool.status === 'running')
        .pop();
      if (!match) {
        return base;
      }
      const tools = state.tools.slice();
      tools[match.index] = {
        ...match.tool,
        status: /^error\b/i.test(preview) ? 'error' : 'done',
        preview
      };
      return { ...base, tools };
    }

    case 'context.attached':
      return state.contextLabels.includes(event.data.label)
        ? base
        : { ...base, contextLabels: [...state.contextLabels, event.data.label] };

    case 'notice':
      return {
        ...base,
        notices: withNotice(base, event.data.message, 'info', event.eventId)
      };

    case 'error':
      return {
        ...base,
        busy: false,
        notices: withNotice(base, event.data.message, 'error', event.eventId)
      };

    default:
      return base;
  }
}

export function dismissNotice(state: StreamSliceState, id: string): StreamSliceState {
  return { ...state, notices: state.notices.filter((n) => n.id !== id) };
}

export function setConnection(
  state: StreamSliceState,
  connection: ConnectionState
): StreamSliceState {
  return state.connection === connection ? state : { ...state, connection };
}
