/**
 * The record of what the agents actually changed.
 *
 * The run has to be able to answer "who changed this file, why, and under
 * which task" after the fact — and the verifier needs to tell an AI-generated
 * change apart from work the user already had in progress. Neither is
 * answerable from a git diff alone, because a diff shows the state, not the
 * authorship.
 */
export type ChangeOperation = 'create' | 'modify' | 'delete';

export interface AgentChange {
  changeId: string;
  agentId: string;
  taskId: string;
  /** Workspace-relative, forward slashes. */
  filePath: string;
  operation: ChangeOperation;
  added: number;
  removed: number;
  /** ISO 8601. */
  timestamp: string;
  /** One line describing the intent, when the tool supplied one. */
  summary?: string;
  /** False when the user rejected the diff, so the record shows both. */
  applied: boolean;
}

export interface ChangeSummary {
  files: number;
  added: number;
  removed: number;
  created: number;
  modified: number;
  deleted: number;
}

function normalise(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Append-only log of proposed changes.
 *
 * Rejected proposals are kept deliberately. "The agent tried to change this
 * and the user said no" is exactly the thing a later agent must not silently
 * retry, and a log that only records successes cannot tell anyone that.
 */
export class ChangeLog {
  private readonly entries: AgentChange[] = [];
  private counter = 0;

  record(
    change: Omit<AgentChange, 'changeId' | 'timestamp'> & { timestamp?: string }
  ): AgentChange {
    this.counter += 1;
    const entry: AgentChange = {
      ...change,
      filePath: normalise(change.filePath),
      changeId: `chg-${this.counter}`,
      timestamp: change.timestamp ?? new Date().toISOString()
    };
    this.entries.push(entry);
    return entry;
  }

  /** Everything recorded, in order. */
  all(): AgentChange[] {
    return [...this.entries];
  }

  /** Only the changes that reached disk. */
  applied(): AgentChange[] {
    return this.entries.filter((e) => e.applied);
  }

  rejected(): AgentChange[] {
    return this.entries.filter((e) => !e.applied);
  }

  byAgent(agentId: string): AgentChange[] {
    return this.entries.filter((e) => e.agentId === agentId);
  }

  /** Who changed a file, most recent last. Answers the authorship question. */
  byFile(filePath: string): AgentChange[] {
    const key = normalise(filePath);
    return this.entries.filter((e) => e.filePath === key);
  }

  /** Distinct files that were actually written. */
  changedFiles(): string[] {
    return [...new Set(this.applied().map((e) => e.filePath))].sort();
  }

  summary(): ChangeSummary {
    const applied = this.applied();
    const files = new Set(applied.map((e) => e.filePath));
    let added = 0;
    let removed = 0;
    let created = 0;
    let modified = 0;
    let deleted = 0;

    for (const entry of applied) {
      added += entry.added;
      removed += entry.removed;
      if (entry.operation === 'create') created += 1;
      else if (entry.operation === 'delete') deleted += 1;
      else modified += 1;
    }

    return { files: files.size, added, removed, created, modified, deleted };
  }

  /** One line for the panel or the session report. */
  describe(): string {
    const s = this.summary();
    if (s.files === 0) {
      return 'No files were changed.';
    }
    return `${s.files} file${s.files === 1 ? '' : 's'} changed, +${s.added} −${s.removed}`;
  }

  clear(): void {
    this.entries.length = 0;
  }
}
