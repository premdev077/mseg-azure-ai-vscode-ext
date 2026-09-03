import type { AgentEvent } from '../../../../src/events/types';
import type { PlanView, VerificationView } from '../../types/view';

/**
 * Planning progress and the verification verdict.
 *
 * These sit together because they bracket the run: the plan says what was
 * going to happen, the verdict says whether it actually did. Nothing here may
 * report a pass the verifier did not report.
 */
export interface VerificationSliceState {
  readonly plan?: PlanView | undefined;
  readonly verification?: VerificationView | undefined;
}

export const initialVerificationSlice: VerificationSliceState = {};

export function reduceVerification(
  state: VerificationSliceState,
  event: AgentEvent
): VerificationSliceState {
  switch (event.type) {
    case 'planning.started':
      return {
        ...state,
        plan: {
          planners: event.data.planners,
          completed: [],
          failed: [],
          files: 0,
          changes: 0,
          conflicts: 0,
          confidence: 0,
          status: 'running'
        }
      };

    case 'planning.agent.completed': {
      if (!state.plan || state.plan.completed.includes(event.data.planner)) {
        return state;
      }
      return {
        ...state,
        plan: {
          ...state.plan,
          completed: [...state.plan.completed, event.data.planner]
        }
      };
    }

    case 'planning.completed': {
      const { files, changes, conflicts, confidence } = event.data;
      return {
        ...state,
        plan: {
          planners: state.plan?.planners ?? [],
          completed: state.plan?.completed ?? [],
          failed: state.plan?.failed ?? [],
          status: 'done',
          files,
          changes,
          conflicts,
          confidence
        }
      };
    }

    case 'verification.started':
      return {
        ...state,
        verification: {
          attempt: event.data.attempt,
          status: 'running',
          typecheck: 'pending',
          lint: 'pending',
          tests: 'pending',
          build: 'pending',
          issues: 0,
          fixes: 0
        }
      };

    case 'verification.completed':
    case 'verification.failed': {
      const d = event.data;
      return {
        ...state,
        verification: {
          attempt: d.attempt,
          // The verdict is exactly what the verifier reported. The UI never
          // infers a pass from the individual checks happening to look green.
          status: d.passed ? 'passed' : 'failed',
          typecheck: d.typecheck,
          lint: d.lint,
          tests: d.tests,
          build: d.build,
          issues: d.issues,
          fixes: d.fixes
        }
      };
    }

    default:
      return state;
  }
}
