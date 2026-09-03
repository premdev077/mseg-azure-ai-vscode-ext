import { Budget } from './budget';
import { TaskGraph, TaskNode } from './taskGraph';

export interface ConcurrencyLimits {
  /** Ceiling across every role at once. */
  maxConcurrentAgents: number;
  /** Per-role ceilings, applied on top of the global one. */
  maxPlanningAgents: number;
  maxCodingAgents: number;
  maxRepairAgents: number;
}

export const DEFAULT_CONCURRENCY: ConcurrencyLimits = {
  maxConcurrentAgents: 5,
  maxPlanningAgents: 5,
  maxCodingAgents: 4,
  maxRepairAgents: 3
};

export type NodeOutcome = { ok: true } | { ok: false; error: string };

export interface SchedulerCallbacks {
  /** Runs one unit of work. Rejecting is treated as a failure, not a crash. */
  run: (node: TaskNode) => Promise<NodeOutcome>;
  /** Called when a node is about to start. */
  onStart?: (node: TaskNode) => void;
  /** Called when a node settles, whatever the outcome. */
  onSettle?: (node: TaskNode, outcome: NodeOutcome) => void;
  /** Called once when the budget stops new work being started. */
  onBudgetExhausted?: (reason: string) => void;
}

export interface SchedulerResult {
  /** True when every node succeeded. */
  ok: boolean;
  started: number;
  succeeded: number;
  failed: number;
  skipped: number;
  cancelled: number;
  /** Set when the run stopped starting work before the graph was finished. */
  stoppedEarly?: string;
}

export interface CancelSignal {
  readonly isCancellationRequested: boolean;
}

/** Which limit governs a role. Roles without their own cap use the global one. */
function roleCap(role: string, limits: ConcurrencyLimits): number {
  switch (role) {
    case 'planner':
      return limits.maxPlanningAgents;
    case 'coder':
      return limits.maxCodingAgents;
    case 'repair':
      return limits.maxRepairAgents;
    default:
      return limits.maxConcurrentAgents;
  }
}

/**
 * Runs a task graph, respecting dependencies, priority and concurrency.
 *
 * The difference from `Promise.all` is the whole point: independent work starts
 * together, dependent work waits, and a failure skips what can no longer run
 * instead of leaving the run spinning. Nothing new starts once the budget is
 * spent or cancellation is requested, but work already in flight is allowed to
 * finish — killing an agent mid-edit is how a half-applied change happens.
 */
export async function runGraph(
  graph: TaskGraph,
  budget: Budget,
  limits: ConcurrencyLimits,
  callbacks: SchedulerCallbacks,
  signal?: CancelSignal
): Promise<SchedulerResult> {
  const validation = graph.validate();
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  const inFlight = new Map<string, Promise<void>>();
  const running = new Map<string, number>();
  let started = 0;
  let stoppedEarly: string | undefined;

  const settle = (node: TaskNode, outcome: NodeOutcome): void => {
    if (outcome.ok) {
      graph.markSucceeded(node.id);
    } else {
      graph.markFailed(node.id, outcome.error);
    }
    running.set(node.role, (running.get(node.role) ?? 1) - 1);
    callbacks.onSettle?.(node, outcome);
  };

  const launch = (node: TaskNode): void => {
    graph.markRunning(node.id);
    budget.noteAgentStarted();
    started += 1;
    running.set(node.role, (running.get(node.role) ?? 0) + 1);
    callbacks.onStart?.(node);

    const promise = callbacks
      .run(node)
      .then(
        (outcome) => settle(node, outcome),
        // A rejected runner is a failed node, never an unhandled rejection
        // that takes the whole run down.
        (err: unknown) =>
          settle(node, {
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          })
      )
      .finally(() => {
        inFlight.delete(node.id);
      });

    inFlight.set(node.id, promise);
  };

  for (;;) {
    if (signal?.isCancellationRequested) {
      stoppedEarly = stoppedEarly ?? 'The run was cancelled.';
      graph.cancelAll();
      break;
    }

    if (!stoppedEarly) {
      const verdict = budget.canStartAgent();
      if (!verdict.ok) {
        stoppedEarly = verdict.reason;
        callbacks.onBudgetExhausted?.(verdict.reason);
      }
    }

    if (!stoppedEarly) {
      for (const node of graph.ready()) {
        if (inFlight.size >= limits.maxConcurrentAgents) {
          break;
        }
        if ((running.get(node.role) ?? 0) >= roleCap(node.role, limits)) {
          continue;
        }
        if (!budget.canStartAgent().ok) {
          break;
        }
        launch(node);
      }
    }

    if (inFlight.size === 0) {
      // Nothing running and nothing startable: either the graph is done, or
      // the budget stopped us and the rest can never run.
      if (stoppedEarly) {
        graph.cancelAll();
      }
      break;
    }

    // Wake as soon as any one node settles, so the next ready node starts
    // immediately rather than waiting for the slowest of a batch.
    await Promise.race([...inFlight.values()]);
  }

  // Let anything still running finish, so cancellation never leaves an orphan.
  if (inFlight.size > 0) {
    await Promise.allSettled([...inFlight.values()]);
  }

  const counts = graph.counts();
  return {
    ok: graph.allSucceeded(),
    started,
    succeeded: counts.succeeded,
    failed: counts.failed,
    skipped: counts.skipped,
    cancelled: counts.cancelled,
    stoppedEarly
  };
}
