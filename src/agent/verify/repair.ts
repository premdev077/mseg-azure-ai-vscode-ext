import { NewTaskNode } from '../taskGraph';
import { FixRequest, VerificationResult } from './types';

/**
 * The verify → repair → verify loop, and where it stops.
 *
 * Bounded on purpose. An agent that cannot fix something in three attempts is
 * usually making it worse, and a loop with no ceiling burns the budget while
 * looking busy. When the cap is reached the run reports failure honestly —
 * what is still broken, what changed, what was checked — rather than quietly
 * settling for whatever state the files are in.
 */
export const DEFAULT_MAX_VERIFICATION_ATTEMPTS = 3;

export interface RepairPlan {
  /** Repair tasks to schedule. Empty when there is nothing actionable. */
  tasks: NewTaskNode[];
  /** Why the loop is continuing or stopping, for the user. */
  reason: string;
  /** False when the run must stop, whether it succeeded or gave up. */
  shouldRetry: boolean;
}

function severityRank(fix: FixRequest, result: VerificationResult): number {
  const blocking = result.issues.some(
    (i) =>
      i.severity === 'blocker' &&
      (i.files.some((f) => fix.files.includes(f)) ||
        i.description.toLowerCase().includes(fix.objective.toLowerCase().slice(0, 30)))
  );
  return blocking ? 0 : 1;
}

/**
 * Groups the verifier's required fixes into repair tasks.
 *
 * Fixes touching the same file become one task rather than several: two repair
 * agents editing one file would contend for its lock and serialise anyway, and
 * a single agent that can see both problems produces a more coherent fix than
 * two that each see half.
 */
export function planRepairs(
  result: VerificationResult,
  options: {
    attempt: number;
    maxAttempts?: number;
    maxRepairAgents?: number;
  }
): RepairPlan {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_VERIFICATION_ATTEMPTS;
  const maxAgents = Math.max(1, options.maxRepairAgents ?? 3);

  if (result.passed) {
    return { tasks: [], reason: 'Verification passed.', shouldRetry: false };
  }

  if (options.attempt >= maxAttempts) {
    return {
      tasks: [],
      shouldRetry: false,
      reason: `Verification failed after ${options.attempt} of ${maxAttempts} attempts. Stopping rather than looping.`
    };
  }

  if (result.requiredFixes.length === 0) {
    return {
      tasks: [],
      shouldRetry: false,
      reason:
        'Verification failed but did not identify anything specific to fix, so there is nothing to hand a repair agent. Reporting the failure as it stands.'
    };
  }

  // Group by the first file each fix names; fixes with no file get their own
  // bucket rather than being merged into an unrelated one.
  const groups = new Map<string, FixRequest[]>();
  const ordered = [...result.requiredFixes].sort(
    (a, b) => severityRank(a, result) - severityRank(b, result)
  );

  for (const fix of ordered) {
    const key = fix.files[0]
      ? fix.files[0].replace(/\\/g, '/')
      : `unscoped-${groups.size}`;
    const list = groups.get(key) ?? [];
    list.push(fix);
    groups.set(key, list);
  }

  // More groups than agents means the tail is merged, never dropped.
  const entries = [...groups.entries()];
  const kept = entries.slice(0, maxAgents - 1);
  const overflow = entries.slice(maxAgents - 1);
  const buckets: Array<[string, FixRequest[]]> =
    overflow.length > 1
      ? [...kept, ['remaining', overflow.flatMap(([, fixes]) => fixes)]]
      : entries;

  const tasks: NewTaskNode[] = buckets.map(([, fixes], index) => {
    const files = [...new Set(fixes.flatMap((f) => f.files))];
    return {
      id: `repair-${options.attempt}-${index + 1}`,
      role: 'repair',
      priority: index === 0 ? 'critical' : 'high',
      objective: renderRepairObjective(fixes, result),
      // A repair agent is scoped to the files its fixes name, so fixing one
      // problem cannot quietly rewrite something unrelated.
      allowedFiles: files.length > 0 ? files : undefined
    };
  });

  return {
    tasks,
    shouldRetry: true,
    reason: `Verification failed on attempt ${options.attempt} of ${maxAttempts}. ${tasks.length} repair task(s) created.`
  };
}

/** The instruction a repair agent receives. */
export function renderRepairObjective(
  fixes: FixRequest[],
  result: VerificationResult
): string {
  const lines: string[] = ['Fix what verification rejected.', ''];

  for (const fix of fixes) {
    lines.push(`- ${fix.objective}`);
    lines.push(`  Why: ${fix.rationale}`);
    if (fix.files.length) {
      lines.push(`  Files: ${fix.files.join(', ')}`);
    }
  }

  const relevant = result.issues.filter((issue) =>
    issue.files.some((f) => fixes.some((fix) => fix.files.includes(f)))
  );
  if (relevant.length) {
    lines.push('', 'What the verifier observed:');
    for (const issue of relevant) {
      lines.push(`- [${issue.severity}] ${issue.description}`);
    }
  }

  const failing = [
    ['type check', result.typecheck],
    ['lint', result.lint],
    ['tests', result.tests],
    ['build', result.build]
  ] as const;
  const failed = failing.filter(([, check]) => check.outcome === 'failed');
  if (failed.length) {
    lines.push('', 'Failing checks:');
    for (const [label, check] of failed) {
      lines.push(`- ${label}: ${check.detail}`);
    }
  }

  lines.push(
    '',
    'Fix the cause, not the symptom. Do not weaken a test, silence a check, or delete the assertion that failed — that is a worse outcome than the original bug, and verification will run again afterwards.'
  );

  return lines.join('\n');
}

/** The final report when the loop ends without a pass. */
export function renderFailureReport(
  result: VerificationResult,
  changedFiles: string[],
  attempts: number,
  maxAttempts: number
): string {
  const lines = [
    'The work could not be verified.',
    '',
    `Attempts: ${attempts} of ${maxAttempts}`,
    ''
  ];

  const checks = [
    ['Type check', result.typecheck],
    ['Lint', result.lint],
    ['Tests', result.tests],
    ['Build', result.build]
  ] as const;

  lines.push('Checks:');
  for (const [label, check] of checks) {
    const mark =
      check.outcome === 'passed' ? '✓' : check.outcome === 'failed' ? '✕' : '–';
    lines.push(`  ${mark} ${label} — ${check.detail}`);
  }

  if (result.issues.length) {
    lines.push('', 'Outstanding issues:');
    for (const issue of result.issues) {
      lines.push(
        `  - [${issue.severity}] ${issue.description}${
          issue.files.length ? ` (${issue.files.join(', ')})` : ''
        }`
      );
    }
  }

  lines.push(
    '',
    changedFiles.length
      ? `Files changed and left on disk:\n${changedFiles.map((f) => `  ${f}`).join('\n')}`
      : 'No files were changed.'
  );

  if (result.unexpectedChanges.length) {
    lines.push(
      '',
      `Files that changed but no task claimed:\n${result.unexpectedChanges
        .map((f) => `  ${f}`)
        .join('\n')}`
    );
  }
  if (result.conflictsDetected) {
    lines.push(
      '',
      'This run edited files that already had uncommitted changes. Review the diff before committing.'
    );
  }

  lines.push('', 'The task was not marked complete.');
  return lines.join('\n');
}
