/**
 * File ownership.
 *
 * Two agents writing one file is the failure this whole design exists to
 * prevent, and it cannot be prevented by asking them nicely — the Coordinator
 * has to be able to say no. An agent that wants a file it does not own waits
 * here rather than editing anyway.
 *
 * Locks are advisory in the sense that only code going through this table is
 * bound by them; the tools are what make that true, by acquiring before they
 * propose an edit.
 */
export interface FileLock {
  filePath: string;
  taskId: string;
  agentId: string;
  acquiredAt: number;
}

export interface LockWaiter {
  filePath: string;
  taskId: string;
  agentId: string;
  resolve: (lock: FileLock) => void;
  reject: (reason: Error) => void;
}

export interface LockGrant {
  lock: FileLock;
  release: () => void;
}

/** Normalised so `src/a.ts` and `src\a.ts` cannot both be held at once. */
export function lockKey(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

export class LockTable {
  private readonly held = new Map<string, FileLock>();
  private readonly queues = new Map<string, LockWaiter[]>();

  /** Non-blocking. Returns undefined when someone else holds the file. */
  tryAcquire(
    filePath: string,
    taskId: string,
    agentId: string,
    at = Date.now()
  ): LockGrant | undefined {
    const key = lockKey(filePath);
    const existing = this.held.get(key);
    if (existing) {
      // Re-entrant for the same agent: a coder patching one file twice in a
      // task should not deadlock against itself.
      if (existing.agentId === agentId) {
        return { lock: existing, release: () => this.release(filePath, agentId) };
      }
      return undefined;
    }
    const lock: FileLock = { filePath, taskId, agentId, acquiredAt: at };
    this.held.set(key, lock);
    return { lock, release: () => this.release(filePath, agentId) };
  }

  /**
   * Waits for the file if it is taken. The returned promise settles when the
   * holder releases, or rejects if the waiter is cancelled.
   */
  acquire(
    filePath: string,
    taskId: string,
    agentId: string,
    at = Date.now()
  ): Promise<LockGrant> {
    const immediate = this.tryAcquire(filePath, taskId, agentId, at);
    if (immediate) {
      return Promise.resolve(immediate);
    }
    const key = lockKey(filePath);
    return new Promise<LockGrant>((resolve, reject) => {
      const queue = this.queues.get(key) ?? [];
      queue.push({
        filePath,
        taskId,
        agentId,
        resolve: (lock) =>
          resolve({ lock, release: () => this.release(filePath, agentId) }),
        reject
      });
      this.queues.set(key, queue);
    });
  }

  /**
   * Releases a file and hands it to the next waiter.
   *
   * Only the holder may release; a stray release from another agent would let
   * two of them believe they own the file at once.
   */
  release(filePath: string, agentId: string, at = Date.now()): boolean {
    const key = lockKey(filePath);
    const lock = this.held.get(key);
    if (!lock || lock.agentId !== agentId) {
      return false;
    }
    this.held.delete(key);

    const queue = this.queues.get(key);
    const next = queue?.shift();
    if (!next) {
      this.queues.delete(key);
      return true;
    }
    if (queue && queue.length === 0) {
      this.queues.delete(key);
    }
    const handed: FileLock = {
      filePath: next.filePath,
      taskId: next.taskId,
      agentId: next.agentId,
      acquiredAt: at
    };
    this.held.set(key, handed);
    next.resolve(handed);
    return true;
  }

  /**
   * Drops everything an agent holds or is waiting for.
   *
   * This is what stops a cancelled agent from leaving a file locked forever —
   * the orphan that would silently stall every later task touching that path.
   */
  releaseAll(agentId: string, at = Date.now()): string[] {
    const released: string[] = [];
    for (const lock of [...this.held.values()]) {
      if (lock.agentId === agentId) {
        this.release(lock.filePath, agentId, at);
        released.push(lock.filePath);
      }
    }
    for (const [key, queue] of [...this.queues.entries()]) {
      const remaining = queue.filter((w) => {
        if (w.agentId !== agentId) {
          return true;
        }
        w.reject(
          new Error(`Agent ${agentId} was cancelled while waiting for ${w.filePath}.`)
        );
        return false;
      });
      if (remaining.length === 0) {
        this.queues.delete(key);
      } else {
        this.queues.set(key, remaining);
      }
    }
    return released;
  }

  /** Every lock currently held. */
  active(): FileLock[] {
    return [...this.held.values()];
  }

  holder(filePath: string): FileLock | undefined {
    return this.held.get(lockKey(filePath));
  }

  /** Agents queued for a file, in order. Answers "why is B waiting". */
  waiting(filePath: string): string[] {
    return (this.queues.get(lockKey(filePath)) ?? []).map((w) => w.agentId);
  }

  /** Rejects every waiter and drops every lock. Used when a run ends. */
  reset(): void {
    for (const queue of this.queues.values()) {
      for (const waiter of queue) {
        waiter.reject(new Error('The run ended before the file became available.'));
      }
    }
    this.queues.clear();
    this.held.clear();
  }
}
