import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_MAX_VERIFICATION_ATTEMPTS,
  planRepairs,
  renderFailureReport,
  renderRepairObjective
} from '../agent/verify/repair';
import { parseVerification } from '../agent/verify/submitVerification';
import {
  describeVerification,
  unverified,
  VerificationResult
} from '../agent/verify/types';

const CTX = { attempt: 1, conflictsDetected: false };

function submit(args: Record<string, unknown>) {
  const parsed = parseVerification(JSON.stringify(args), CTX);
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
  return (parsed as { ok: true; result: VerificationResult }).result;
}

const PASSING = {
  implementationCorrect: true,
  summary: 'Looks right.',
  typecheck: { outcome: 'passed', detail: 'tsc clean' },
  lint: { outcome: 'passed', detail: 'eslint clean' },
  tests: { outcome: 'passed', detail: '28 passed' },
  build: { outcome: 'passed', detail: 'built' }
};

// --- the gate --------------------------------------------------------------

test('everything passing and correct verifies', () => {
  const result = submit(PASSING);
  assert.equal(result.passed, true);
});

test('a failing check cannot be overridden by the model claiming success', () => {
  // The model reports a failing test but ticks implementationCorrect. The gate
  // is computed from observations, so it must not pass.
  const result = submit({
    ...PASSING,
    tests: { outcome: 'failed', detail: '2 tests failed' }
  });

  assert.equal(result.passed, false, 'a failing check must sink the verdict');
  assert.equal(result.implementationCorrect, true, 'the claim is still recorded');
});

test('an implementation judged incorrect fails even with every check green', () => {
  const result = submit({ ...PASSING, implementationCorrect: false });
  assert.equal(result.passed, false, 'compiling is not the same as implementing');
});

test('a blocker issue fails the verdict', () => {
  const result = submit({
    ...PASSING,
    issues: [
      { severity: 'blocker', description: 'Auth check removed', files: ['a.ts'] }
    ]
  });
  assert.equal(result.passed, false);
});

test('a minor issue does not fail the verdict', () => {
  const result = submit({
    ...PASSING,
    issues: [{ severity: 'minor', description: 'Naming could be clearer', files: [] }]
  });
  assert.equal(result.passed, true);
});

test('an unexpected change fails the verdict', () => {
  const result = submit({ ...PASSING, unexpectedChanges: ['src/unrelated.ts'] });
  assert.equal(result.passed, false, 'a file nobody claimed must not pass silently');
});

test('skipped checks do not fail the verdict but are not passes either', () => {
  const result = submit({
    implementationCorrect: true,
    summary: 'No test setup in this project.',
    typecheck: { outcome: 'passed', detail: 'tsc clean' },
    tests: { outcome: 'skipped', detail: 'no test script' }
  });

  assert.equal(result.passed, true, 'a project without tests can still verify');
  assert.equal(result.tests.outcome, 'skipped');
  assert.equal(result.lint.outcome, 'skipped', 'an unreported check is skipped');
});

test('an unreadable outcome degrades to skipped, never to passed', () => {
  const result = submit({
    ...PASSING,
    tests: { outcome: 'probably fine', detail: 'looked ok' }
  });
  assert.equal(
    result.tests.outcome,
    'skipped',
    'success must be observed, not inferred'
  );
});

test('a missing check object is skipped, not passed', () => {
  const result = submit({ implementationCorrect: true, summary: 's' });
  for (const check of [result.tests, result.typecheck, result.lint, result.build]) {
    assert.equal(check.outcome, 'skipped');
  }
});

// --- parsing ---------------------------------------------------------------

test('a verdict without a summary is rejected', () => {
  const parsed = parseVerification(
    JSON.stringify({ implementationCorrect: true }),
    CTX
  );
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.error, /without a summary/);
});

test('invalid JSON is reported rather than thrown', () => {
  const parsed = parseVerification('{oops', CTX);
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.error, /not valid JSON/);
});

test('implementationCorrect must be explicitly true', () => {
  for (const value of ['yes', 1, undefined, null]) {
    const result = submit({ summary: 's', implementationCorrect: value });
    assert.equal(result.implementationCorrect, false, `${String(value)} is not true`);
    assert.equal(result.passed, false);
  }
});

test('malformed issues and fixes are dropped, not the whole verdict', () => {
  const result = submit({
    ...PASSING,
    issues: [
      { severity: 'blocker', description: 'real' },
      { severity: 'blocker' },
      null
    ],
    requiredFixes: [
      { objective: 'do it', rationale: 'because' },
      { rationale: 'orphan' }
    ]
  });

  assert.equal(result.issues.length, 1);
  assert.equal(result.requiredFixes.length, 1);
  assert.equal(result.requiredFixes[0].files.length, 0, 'a fix may name no file');
});

test('conflicts detected by the baseline are carried into the verdict', () => {
  const parsed = parseVerification(JSON.stringify(PASSING), {
    attempt: 2,
    conflictsDetected: true
  });
  assert.equal(parsed.ok, true);
  const result = (parsed as { ok: true; result: VerificationResult }).result;
  assert.equal(result.conflictsDetected, true);
  assert.equal(result.attempt, 2);
});

test('an unverifiable run fails rather than passing by default', () => {
  const result = unverified('The verifier could not be reached.', 1);
  assert.equal(result.passed, false);
  assert.equal(result.issues[0].severity, 'blocker');
});

// --- repair loop -----------------------------------------------------------

const FAILED: VerificationResult = {
  passed: false,
  implementationCorrect: false,
  typecheck: { outcome: 'failed', detail: '2 errors' },
  lint: { outcome: 'passed', detail: 'clean' },
  tests: { outcome: 'failed', detail: '1 failed' },
  build: { outcome: 'skipped', detail: 'not run' },
  unexpectedChanges: [],
  conflictsDetected: false,
  issues: [
    { severity: 'blocker', description: 'Type error in auth', files: ['src/auth.ts'] }
  ],
  requiredFixes: [
    { objective: 'Fix the type error', files: ['src/auth.ts'], rationale: 'tsc fails' },
    {
      objective: 'Fix the failing test',
      files: ['tests/auth.test.ts'],
      rationale: 'assertion fails'
    }
  ],
  summary: 'Two problems.',
  attempt: 1
};

test('a passing verdict creates no repair work', () => {
  const plan = planRepairs({ ...FAILED, passed: true }, { attempt: 1 });
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.shouldRetry, false);
  assert.match(plan.reason, /passed/);
});

test('a failed verdict creates one repair task per file', () => {
  const plan = planRepairs(FAILED, { attempt: 1 });

  assert.equal(plan.shouldRetry, true);
  assert.equal(plan.tasks.length, 2);
  assert.deepEqual(plan.tasks[0].allowedFiles, ['src/auth.ts']);
  assert.deepEqual(plan.tasks[1].allowedFiles, ['tests/auth.test.ts']);
  assert.equal(plan.tasks[0].role, 'repair');
});

test('repair agents are scoped to the files their fixes name', () => {
  const plan = planRepairs(FAILED, { attempt: 1 });
  for (const task of plan.tasks) {
    assert.ok(
      task.allowedFiles && task.allowedFiles.length > 0,
      'an unscoped repair agent could rewrite anything'
    );
  }
});

test('fixes touching one file become one task, not several', () => {
  const plan = planRepairs(
    {
      ...FAILED,
      requiredFixes: [
        { objective: 'A', files: ['src/auth.ts'], rationale: 'r1' },
        { objective: 'B', files: ['src/auth.ts'], rationale: 'r2' }
      ]
    },
    { attempt: 1 }
  );

  assert.equal(plan.tasks.length, 1, 'two agents on one file would just serialise');
  assert.match(plan.tasks[0].objective, /A/);
  assert.match(plan.tasks[0].objective, /B/);
});

test('the attempt cap stops the loop', () => {
  const plan = planRepairs(FAILED, { attempt: 3, maxAttempts: 3 });
  assert.equal(plan.shouldRetry, false);
  assert.equal(plan.tasks.length, 0);
  assert.match(plan.reason, /3 of 3 attempts/);
  assert.match(plan.reason, /Stopping rather than looping/);
});

test('the default cap is three', () => {
  assert.equal(DEFAULT_MAX_VERIFICATION_ATTEMPTS, 3);
  assert.equal(planRepairs(FAILED, { attempt: 2 }).shouldRetry, true);
  assert.equal(planRepairs(FAILED, { attempt: 3 }).shouldRetry, false);
});

test('a failure with nothing actionable stops instead of retrying blindly', () => {
  const plan = planRepairs({ ...FAILED, requiredFixes: [] }, { attempt: 1 });
  assert.equal(plan.shouldRetry, false);
  assert.match(plan.reason, /did not identify anything specific/);
});

test('repair tasks never exceed the agent limit, and no fix is dropped', () => {
  const fixes = Array.from({ length: 9 }, (_, i) => ({
    objective: `fix ${i}`,
    files: [`src/file${i}.ts`],
    rationale: 'r'
  }));
  const plan = planRepairs(
    { ...FAILED, requiredFixes: fixes },
    { attempt: 1, maxRepairAgents: 3 }
  );

  assert.ok(
    plan.tasks.length <= 3,
    `expected at most 3 tasks, got ${plan.tasks.length}`
  );
  const covered = plan.tasks.flatMap((t) => t.allowedFiles ?? []);
  for (const fix of fixes) {
    assert.ok(covered.includes(fix.files[0]), `${fix.files[0]} was dropped`);
  }
});

test('a repair objective forbids weakening the check instead of fixing it', () => {
  const objective = renderRepairObjective(FAILED.requiredFixes, FAILED);

  assert.match(objective, /Fix the type error/);
  assert.match(objective, /tsc fails/);
  assert.match(objective, /Failing checks:/);
  assert.match(objective, /type check: 2 errors/);
  assert.match(objective, /Do not weaken a test, silence a check/);
});

// --- reporting -------------------------------------------------------------

test('a passing verdict renders as verified', () => {
  const text = describeVerification(submit(PASSING));
  assert.match(text, /✓ Type check/);
  assert.match(text, /✓ Tests/);
  assert.match(text, /\bVERIFIED\b/);
  assert.ok(!text.includes('NOT VERIFIED'));
});

test('a failing verdict renders the failures and never claims success', () => {
  const text = describeVerification(FAILED);
  assert.match(text, /✕ Type check — 2 errors/);
  assert.match(text, /✕ Tests — 1 failed/);
  assert.match(text, /– Build/);
  assert.match(text, /NOT VERIFIED/);
  assert.match(text, /\[blocker\] Type error in auth/);
});

test('the failure report says what is broken, what changed, and that it is not complete', () => {
  const report = renderFailureReport(
    FAILED,
    ['src/auth.ts', 'tests/auth.test.ts'],
    3,
    3
  );

  assert.match(report, /could not be verified/);
  assert.match(report, /Attempts: 3 of 3/);
  assert.match(report, /✕ Type check/);
  assert.match(report, /Files changed and left on disk/);
  assert.match(report, /src\/auth\.ts/);
  assert.match(report, /The task was not marked complete\./);
});

test('the failure report surfaces unclaimed changes and mixed-in user work', () => {
  const report = renderFailureReport(
    { ...FAILED, unexpectedChanges: ['src/mystery.ts'], conflictsDetected: true },
    ['src/auth.ts'],
    2,
    3
  );

  assert.match(report, /no task claimed/);
  assert.match(report, /src\/mystery\.ts/);
  assert.match(report, /already had uncommitted changes/);
});
