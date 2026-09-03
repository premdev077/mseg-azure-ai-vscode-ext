import { EventBus } from '../events/bus';
import type { AgentEventType, EmitOptions, EventDataMap } from '../events/types';
import { Budget, BudgetLimits } from './budget';
import { LockTable } from './locks';
import { AgentRole } from './roles';
import {
  ConcurrencyLimits,
  DEFAULT_CONCURRENCY,
  NodeOutcome,
  runGraph
} from './scheduler';
import { NewTaskNode, TaskGraph, TaskNode, TaskState } from './taskGraph';

/**
 * The single authority for a run.
 *
 * It owns the task graph, the lock table, the budget and the agent registry;
 * agents return results and never mutate shared state themselves. That is what
 * keeps a multi-agent run traceable — every decision has one place it was made.
 *
 * Today it runs one node, which is the existing chat turn, so its observable
 * behaviour is unchanged. The machinery is here first on purpose: introducing
 * parallelism and introducing the thing that controls parallelism at the same
 * time is how you get a system nobody can debug.
 */
export interface CoordinatorOptions {
  bus: EventBus;
  taskId: string;
  concurrency?: Partial<ConcurrencyLimits>;
  budget?: Partial<BudgetLimits>;
  clock?: () => number;
}

/** What an agent runner is handed. */
export interface AgentContext {
  node: TaskNode;
  agentId: string;
  taskId: string;
  /** Acquire before editing; released automatically when the agent settles. */
  locks: LockTable;
  budget: Budget;
}

export type AgentRunner = (context: AgentContext) => Promise<NodeOutcome>;

export interface RunOutcome {
  state: TaskState;
  succeeded: number;
  failed: number;
  skipped: number;
  cancelled: number;
  /** Set when the budget or cancellation stopped work early. */
  stoppedEarly?: string;
  summary: string;
}

export interface CancelSignal {
  readonly isCancellationRequested: boolean;
}

export class Coordinator {
  readonly graph = new TaskGraph();
  readonly locks = new LockTable();
  readonly budget: Budget;

  private readonly bus: EventBus;
  private readonly taskId: string;
  private readonly concurrency: ConcurrencyLimits;
  private state: TaskState = 'created';
  private agentSeq = 0;
  /** agentId → node id, so a run can say which agent did what. */
  private readonly registry = new Map<string, string>();

  constructor(options: CoordinatorOptions) {
    this.bus = options.bus;
    this.taskId = options.taskId;
    this.concurrency = { ...DEFAULT_CONCURRENCY, ...options.concurrency };
    this.budget = new Budget(options.budget, options.clock);
    this.emit('task.created', { taskId: this.taskId });
  }

  get currentState(): TaskState {
    return this.state;
  }

  /** agentId → node id for everything created in this run. */
  agents(): Array<{ agentId: string; nodeId: string }> {
    return [...this.registry.entries()].map(([agentId, nodeId]) => ({
      agentId,
      nodeId
    }));
  }

  addTask(node: NewTaskNode): TaskNode {
    return this.graph.add(node);
  }

  private setState(state: TaskState, data: Record<string, unknown> = {}): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    const type =
      state === 'completed'
        ? 'task.completed'
        : state === 'failed' || state === 'timeout'
          ? 'task.failed'
          : state === 'cancelled'
            ? 'task.cancelled'
            : 'task.started';
    this.emit(type, { state, ...data });
  }

  private emit<T extends AgentEventType>(
    type: T,
    data: EventDataMap[T],
    agentId?: string
  ): void {
    this.bus.emit({ type, taskId: this.taskId, agentId, data } as EmitOptions);
  }

  private nextAgentId(role: AgentRole): string {
    this.agentSeq += 1;
    return `${role}-${this.agentSeq}`;
  }

  /**
   * Runs the graph to completion.
   *
   * Locks are released per agent as it settles, and again wholesale at the end,
   * so a cancelled or thrown agent can never leave a file owned by nobody.
   */
  async run(runner: AgentRunner, signal?: CancelSignal): Promise<RunOutcome> {
    const validation = this.graph.validate();
    if (!validation.ok) {
      this.setState('failed', { error: validation.error });
      return {
        state: 'failed',
        succeeded: 0,
        failed: 0,
        skipped: 0,
        cancelled: 0,
        summary: validation.error
      };
    }

    this.setState('executing');

    try {
      const result = await runGraph(
        this.graph,
        this.budget,
        this.concurrency,
        {
          run: async (node) => {
            const agentId = this.nextAgentId(node.role);
            this.registry.set(agentId, node.id);
            this.emit(
              'agent.started',
              { nodeId: node.id, objective: node.objective, role: node.role },
              agentId
            );
            try {
              return await runner({
                node,
                agentId,
                taskId: this.taskId,
                locks: this.locks,
                budget: this.budget
              });
            } finally {
              // Whatever happened — success, failure, throw — this agent stops
              // owning files. A lock outliving its agent stalls every later
              // task that touches the same path.
              const released = this.locks.releaseAll(agentId);
              for (const filePath of released) {
                this.emit('file.unlocked', { filePath }, agentId);
              }
            }
          },
          onStart: (node) => {
            const blocked = this.graph.blockedBy(node.id);
            this.emit('agent.created', {
              nodeId: node.id,
              role: node.role,
              priority: node.priority,
              waitedOn: blocked
            });
          },
          onSettle: (node, outcome) => {
            this.emit(outcome.ok ? 'agent.completed' : 'agent.failed', {
              nodeId: node.id,
              role: node.role,
              durationMs:
                node.finishedAt && node.startedAt
                  ? node.finishedAt - node.startedAt
                  : undefined,
              ...(outcome.ok ? {} : { error: outcome.error })
            });
          },
          onBudgetExhausted: (reason) => {
            this.emit('notice', { message: reason });
          }
        },
        signal
      );

      const counts = this.graph.counts();
      const cancelled = signal?.isCancellationRequested === true;

      // Only the verifier may declare success once it exists. Until then a
      // clean graph is reported as executed, not verified.
      const state: TaskState = cancelled
        ? 'cancelled'
        : result.ok
          ? 'changes_ready'
          : 'failed';

      this.setState(state, {
        succeeded: counts.succeeded,
        failed: counts.failed,
        skipped: counts.skipped,
        stoppedEarly: result.stoppedEarly
      });

      return {
        state,
        succeeded: counts.succeeded,
        failed: counts.failed,
        skipped: counts.skipped,
        cancelled: counts.cancelled,
        stoppedEarly: result.stoppedEarly,
        summary: this.describe(result.stoppedEarly)
      };
    } finally {
      this.locks.reset();
    }
  }

  /** Stops the run, cancelling pending work and freeing every lock. */
  cancel(): void {
    this.graph.cancelAll();
    this.locks.reset();
    this.setState('cancelled');
  }

  private describe(stoppedEarly?: string): string {
    const counts = this.graph.counts();
    const parts = [`${counts.succeeded} succeeded`];
    if (counts.failed) parts.push(`${counts.failed} failed`);
    if (counts.skipped) parts.push(`${counts.skipped} skipped`);
    if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);
    const base = `${parts.join(', ')} · ${this.budget.describe()}`;
    return stoppedEarly ? `${base}. ${stoppedEarly}` : base;
  }
}
