import { AgentRole } from './roles';

/**
 * The lifecycle of a whole run, as the brief specifies it. This is what the
 * Coordinator reports and what decides whether the work may be called done —
 * only the verifier can reach `completed`.
 */
export type TaskState =
  | 'created'
  | 'planning'
  | 'plan_ready'
  | 'executing'
  | 'changes_ready'
  | 'verifying'
  | 'repairing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

/** The state of one unit of work inside the graph. */
export type NodeState =
  'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export type Priority = 'critical' | 'high' | 'normal' | 'low';

const PRIORITY_ORDER: Record<Priority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3
};

export interface TaskNode {
  id: string;
  objective: string;
  role: AgentRole;
  priority: Priority;
  /** Ids that must succeed before this may start. */
  dependencies: string[];
  /**
   * Paths or globs this node may modify. Undefined means unrestricted, which
   * is what the single-agent path uses. Enforced when scoping lands.
   */
  allowedFiles?: string[];
  state: NodeState;
  /** Set when the node settles. */
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface NewTaskNode {
  id: string;
  objective: string;
  role: AgentRole;
  priority?: Priority;
  dependencies?: string[];
  allowedFiles?: string[];
}

export type GraphValidation =
  { ok: true; order: string[] } | { ok: false; error: string };

/**
 * A dependency graph of work, and the rules for what may run next.
 *
 * The point of a DAG rather than `Promise.all` is that most real work is only
 * partly independent: the frontend task and the backend task can run together,
 * but integration tests cannot start until both have finished. The graph is
 * what knows that, and what can answer "why is this one waiting".
 */
export class TaskGraph {
  private readonly nodes = new Map<string, TaskNode>();

  add(node: NewTaskNode): TaskNode {
    if (this.nodes.has(node.id)) {
      throw new Error(`Duplicate task id "${node.id}".`);
    }
    const created: TaskNode = {
      id: node.id,
      objective: node.objective,
      role: node.role,
      priority: node.priority ?? 'normal',
      dependencies: [...(node.dependencies ?? [])],
      allowedFiles: node.allowedFiles ? [...node.allowedFiles] : undefined,
      state: 'pending'
    };
    this.nodes.set(node.id, created);
    return created;
  }

  get size(): number {
    return this.nodes.size;
  }

  get(id: string): TaskNode | undefined {
    return this.nodes.get(id);
  }

  all(): TaskNode[] {
    return [...this.nodes.values()];
  }

  /**
   * Checks the graph is runnable and returns a topological order.
   *
   * A cycle or a dependency on a task that does not exist would otherwise show
   * up as a run that quietly stalls with everything pending, which is a
   * miserable thing to debug. Better to refuse the graph.
   */
  validate(): GraphValidation {
    for (const node of this.nodes.values()) {
      for (const dep of node.dependencies) {
        if (!this.nodes.has(dep)) {
          return {
            ok: false,
            error: `Task "${node.id}" depends on "${dep}", which does not exist.`
          };
        }
        if (dep === node.id) {
          return { ok: false, error: `Task "${node.id}" depends on itself.` };
        }
      }
    }

    // Kahn's algorithm: gives the order and finds a cycle in one pass.
    const remaining = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const node of this.nodes.values()) {
      remaining.set(node.id, node.dependencies.length);
      for (const dep of node.dependencies) {
        const list = dependents.get(dep) ?? [];
        list.push(node.id);
        dependents.set(dep, list);
      }
    }

    const queue = [...remaining.entries()]
      .filter(([, count]) => count === 0)
      .map(([id]) => id)
      .sort();
    const order: string[] = [];

    while (queue.length > 0) {
      const id = queue.shift() as string;
      order.push(id);
      for (const next of dependents.get(id) ?? []) {
        const count = (remaining.get(next) ?? 0) - 1;
        remaining.set(next, count);
        if (count === 0) {
          queue.push(next);
        }
      }
    }

    if (order.length !== this.nodes.size) {
      const stuck = [...remaining.entries()]
        .filter(([, count]) => count > 0)
        .map(([id]) => id)
        .sort();
      return {
        ok: false,
        error: `The task graph has a dependency cycle involving: ${stuck.join(', ')}.`
      };
    }

    return { ok: true, order };
  }

  /**
   * Pending nodes whose dependencies have all succeeded, highest priority
   * first and stable within a priority so a run is reproducible.
   */
  ready(): TaskNode[] {
    return this.all()
      .filter(
        (node) =>
          node.state === 'pending' &&
          node.dependencies.every((dep) => this.get(dep)?.state === 'succeeded')
      )
      .sort(
        (a, b) =>
          PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
          a.id.localeCompare(b.id)
      );
  }

  /**
   * Why a node has not started: the dependencies it is still waiting on. Empty
   * when it is ready or already running. This exists because "why was agent B
   * waiting" is a question the run has to be able to answer.
   */
  blockedBy(id: string): string[] {
    const node = this.get(id);
    if (!node || node.state !== 'pending') {
      return [];
    }
    return node.dependencies.filter((dep) => this.get(dep)?.state !== 'succeeded');
  }

  markRunning(id: string, at = Date.now()): void {
    const node = this.require(id);
    node.state = 'running';
    node.startedAt = at;
  }

  markSucceeded(id: string, at = Date.now()): void {
    const node = this.require(id);
    node.state = 'succeeded';
    node.finishedAt = at;
  }

  /**
   * Fails a node and skips everything that can no longer run.
   *
   * Cascading matters: a dependent left `pending` would make the scheduler
   * spin waiting for a dependency that will never succeed.
   */
  markFailed(id: string, error: string, at = Date.now()): string[] {
    const node = this.require(id);
    node.state = 'failed';
    node.error = error;
    node.finishedAt = at;
    return this.skipDependentsOf(id, at);
  }

  markCancelled(id: string, at = Date.now()): string[] {
    const node = this.require(id);
    if (node.state === 'succeeded' || node.state === 'failed') {
      return [];
    }
    node.state = 'cancelled';
    node.finishedAt = at;
    return this.skipDependentsOf(id, at);
  }

  /** Cancels everything not already settled. Used when the user stops a run. */
  cancelAll(at = Date.now()): string[] {
    const touched: string[] = [];
    for (const node of this.nodes.values()) {
      if (node.state === 'pending' || node.state === 'running') {
        node.state = 'cancelled';
        node.finishedAt = at;
        touched.push(node.id);
      }
    }
    return touched;
  }

  private skipDependentsOf(id: string, at: number): string[] {
    const skipped: string[] = [];
    let changed = true;
    // Repeat to catch transitive dependents, whose own dependents must also go.
    while (changed) {
      changed = false;
      for (const node of this.nodes.values()) {
        if (node.state !== 'pending') {
          continue;
        }
        const blocked = node.dependencies.some((dep) => {
          const parent = this.get(dep);
          return (
            parent?.state === 'failed' ||
            parent?.state === 'skipped' ||
            parent?.state === 'cancelled'
          );
        });
        if (blocked) {
          node.state = 'skipped';
          node.error = `Skipped: a task it depends on did not succeed (triggered by "${id}").`;
          node.finishedAt = at;
          skipped.push(node.id);
          changed = true;
        }
      }
    }
    return skipped;
  }

  /** True when nothing is pending or running. */
  isSettled(): boolean {
    return this.all().every(
      (node) => node.state !== 'pending' && node.state !== 'running'
    );
  }

  /** True when every node succeeded. */
  allSucceeded(): boolean {
    return this.all().every((node) => node.state === 'succeeded');
  }

  counts(): Record<NodeState, number> {
    const counts: Record<NodeState, number> = {
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      cancelled: 0
    };
    for (const node of this.nodes.values()) {
      counts[node.state] += 1;
    }
    return counts;
  }

  private require(id: string): TaskNode {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Unknown task "${id}".`);
    }
    return node;
  }
}
