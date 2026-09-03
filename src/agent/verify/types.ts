/**
 * The independent verifier's verdict.
 *
 * The rule this type exists to enforce: a coding agent saying "I completed the
 * task" is not completion. Only a verifier that re-inspected the repository
 * itself can move a run to COMPLETED, and it reports each check separately so
 * "tests passed" can never be inferred from "typecheck passed".
 */
export type CheckOutcome = 'passed' | 'failed' | 'skipped';

export interface CheckResult {
  outcome: CheckOutcome;
  /** Why, in one line. For a skip, why it could not run. */
  detail: string;
}

export type IssueSeverity = 'blocker' | 'major' | 'minor';

export interface VerificationIssue {
  severity: IssueSeverity;
  description: string;
  /** Workspace-relative paths, where the issue is localised. */
  files: string[];
}

export interface FixRequest {
  /** What must change, specifically enough for a repair agent to act on. */
  objective: string;
  files: string[];
  /** Why this is required, so the repair agent does not guess at intent. */
  rationale: string;
}

export interface VerificationResult {
  /** The single gate. False keeps the run out of COMPLETED. */
  passed: boolean;
  /** Whether the change actually does what was asked. */
  implementationCorrect: boolean;
  tests: CheckResult;
  typecheck: CheckResult;
  lint: CheckResult;
  build: CheckResult;
  /** Files that changed but no agent claimed. Never ignored. */
  unexpectedChanges: string[];
  /** True when the run touched files the user already had in progress. */
  conflictsDetected: boolean;
  issues: VerificationIssue[];
  requiredFixes: FixRequest[];
  summary: string;
  /** Which attempt produced this, 1-based. */
  attempt: number;
}

export const SKIPPED: CheckResult = {
  outcome: 'skipped',
  detail: 'Not run.'
};

/**
 * A result for when verification could not run at all.
 *
 * It fails rather than passes, deliberately: an unverifiable run is not a
 * verified one, and defaulting to success here would defeat the whole gate.
 */
export function unverified(reason: string, attempt: number): VerificationResult {
  return {
    passed: false,
    implementationCorrect: false,
    tests: SKIPPED,
    typecheck: SKIPPED,
    lint: SKIPPED,
    build: SKIPPED,
    unexpectedChanges: [],
    conflictsDetected: false,
    issues: [{ severity: 'blocker', description: reason, files: [] }],
    requiredFixes: [],
    summary: reason,
    attempt
  };
}

/** Renders a result for the panel and the final reply. */
export function describeVerification(result: VerificationResult): string {
  const mark = (c: CheckResult): string =>
    c.outcome === 'passed' ? '✓' : c.outcome === 'failed' ? '✕' : '–';

  const lines = [
    `${mark(result.typecheck)} Type check — ${result.typecheck.detail}`,
    `${mark(result.lint)} Lint — ${result.lint.detail}`,
    `${mark(result.tests)} Tests — ${result.tests.detail}`,
    `${mark(result.build)} Build — ${result.build.detail}`,
    `${result.implementationCorrect ? '✓' : '✕'} Implements the request`
  ];

  if (result.unexpectedChanges.length > 0) {
    lines.push(
      `✕ ${result.unexpectedChanges.length} file(s) changed that no task claimed: ${result.unexpectedChanges.join(', ')}`
    );
  }
  if (result.conflictsDetected) {
    lines.push('! The run edited files that already had uncommitted changes.');
  }

  lines.push('', result.passed ? 'VERIFIED' : 'NOT VERIFIED', '', result.summary);

  if (!result.passed && result.issues.length > 0) {
    lines.push('', 'Issues:');
    for (const issue of result.issues) {
      lines.push(
        `- [${issue.severity}] ${issue.description}${
          issue.files.length ? ` (${issue.files.join(', ')})` : ''
        }`
      );
    }
  }

  return lines.join('\n');
}
