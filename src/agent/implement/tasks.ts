import { AggregatedPlan } from '../planning/types';
import { partitionByArea } from '../scope';
import { NewTaskNode } from '../taskGraph';

/**
 * Turns an aggregated plan into scoped implementation tasks.
 *
 * The split is by area rather than by file, for one reason: two agents
 * assigned the same file contend for its lock and serialise anyway, so
 * splitting finely buys nothing and costs a model call. Grouping by area keeps
 * related edits with one agent that can see them together, which produces a
 * more coherent change than two agents each holding half of it.
 */
export interface ImplementationTasksOptions {
  /** Ceiling on concurrent coders, from the concurrency settings. */
  maxCoders: number;
  /** Files that must be handled by one agent because they interact. */
  keepTogether?: string[][];
}

export function buildImplementationTasks(
  aggregate: AggregatedPlan,
  options: ImplementationTasksOptions
): NewTaskNode[] {
  const files = aggregate.changes.map((c) => c.filePath);
  if (files.length === 0) {
    return [];
  }

  const groups = partitionByArea(files, Math.max(1, options.maxCoders));
  const rationale = new Map(aggregate.changes.map((c) => [c.filePath, c]));

  return groups.map((group, index) => {
    const lines: string[] = [`Implement the planned changes in ${group.area}.`, ''];

    for (const file of group.files) {
      const change = rationale.get(file);
      lines.push(
        change
          ? `- **${change.kind}** \`${file}\` — ${change.rationale}`
          : `- \`${file}\``
      );
    }

    const conflicts = aggregate.conflicts.filter((c) =>
      group.files.includes(c.filePath)
    );
    if (conflicts.length) {
      lines.push(
        '',
        'The planners disagreed about these. Read the file, decide, and say which you chose and why:'
      );
      for (const conflict of conflicts) {
        lines.push(`- \`${conflict.filePath}\`: ${conflict.description}`);
      }
    }

    return {
      id: `implement-${index + 1}`,
      role: 'coder',
      // Deleting is the least recoverable, so it goes first while the rest of
      // the tree is still as the planners saw it.
      priority: group.files.some((f) => rationale.get(f)?.kind === 'delete')
        ? 'high'
        : 'normal',
      objective: lines.join('\n'),
      allowedFiles: group.files
    } satisfies NewTaskNode;
  });
}
