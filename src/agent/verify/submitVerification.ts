import { ToolSpec } from '../../azureClient';
import {
  CheckOutcome,
  CheckResult,
  FixRequest,
  IssueSeverity,
  VerificationIssue,
  VerificationResult
} from './types';

export const SUBMIT_VERIFICATION_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'submit_verification',
    description:
      'Report your verdict. Call this exactly once, after you have run the checks and reviewed the diff yourself. Report only outcomes you actually observed — a check you did not run is "skipped", never "passed".',
    parameters: {
      type: 'object',
      properties: {
        implementationCorrect: {
          type: 'boolean',
          description:
            'Does the change actually do what the user asked? Judge this from the diff, not from what the agents said they did.'
        },
        typecheck: checkSchema('Type checking'),
        lint: checkSchema('Linting'),
        tests: checkSchema('Tests'),
        build: checkSchema('Build'),
        unexpectedChanges: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Files in the diff that no task set out to change. Report them even if they look harmless.'
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
              description: { type: 'string' },
              files: { type: 'array', items: { type: 'string' } }
            },
            required: ['severity', 'description']
          }
        },
        requiredFixes: {
          type: 'array',
          description:
            'What must change for this to pass. Each one becomes a repair task, so be specific.',
          items: {
            type: 'object',
            properties: {
              objective: {
                type: 'string',
                description: 'The concrete change required.'
              },
              files: { type: 'array', items: { type: 'string' } },
              rationale: { type: 'string', description: 'Why it is required.' }
            },
            required: ['objective', 'rationale']
          }
        },
        summary: {
          type: 'string',
          description: 'Two or three sentences on the state of the work.'
        }
      },
      required: ['implementationCorrect', 'summary']
    }
  }
};

function checkSchema(label: string): Record<string, unknown> {
  return {
    type: 'object',
    description: `${label}: what you observed when you ran it.`,
    properties: {
      outcome: {
        type: 'string',
        enum: ['passed', 'failed', 'skipped'],
        description:
          'Use "skipped" when the project has no such check or you did not run it. Never "passed" for something you did not see pass.'
      },
      detail: {
        type: 'string',
        description: 'The command and its result, or why it was skipped.'
      }
    },
    required: ['outcome', 'detail']
  };
}

const OUTCOMES: CheckOutcome[] = ['passed', 'failed', 'skipped'];
const SEVERITIES: IssueSeverity[] = ['blocker', 'major', 'minor'];

/**
 * Reads one check.
 *
 * An unreadable outcome becomes `skipped`, never `passed`. The whole point of
 * the verifier is that success has to be observed, so an ambiguous field must
 * degrade towards "we do not know".
 */
function parseCheck(value: unknown): CheckResult {
  if (!value || typeof value !== 'object') {
    return { outcome: 'skipped', detail: 'Not reported.' };
  }
  const raw = value as Record<string, unknown>;
  const outcome = OUTCOMES.includes(raw.outcome as CheckOutcome)
    ? (raw.outcome as CheckOutcome)
    : 'skipped';
  const detail =
    typeof raw.detail === 'string' && raw.detail.trim()
      ? raw.detail.trim()
      : outcome === 'skipped'
        ? 'Not run.'
        : '(no detail given)';
  return { outcome, detail };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter(Boolean)
    )
  ];
}

function parseIssues(value: unknown): VerificationIssue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: VerificationIssue[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const raw = item as Record<string, unknown>;
    const description =
      typeof raw.description === 'string' ? raw.description.trim() : '';
    if (!description) {
      continue;
    }
    out.push({
      severity: SEVERITIES.includes(raw.severity as IssueSeverity)
        ? (raw.severity as IssueSeverity)
        : 'major',
      description,
      files: asStringArray(raw.files)
    });
  }
  return out;
}

function parseFixes(value: unknown): FixRequest[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: FixRequest[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const raw = item as Record<string, unknown>;
    const objective = typeof raw.objective === 'string' ? raw.objective.trim() : '';
    if (!objective) {
      continue;
    }
    out.push({
      objective,
      files: asStringArray(raw.files),
      rationale:
        typeof raw.rationale === 'string' && raw.rationale.trim()
          ? raw.rationale.trim()
          : 'Required by verification.'
    });
  }
  return out;
}

export type VerificationParse =
  { ok: true; result: VerificationResult } | { ok: false; error: string };

/**
 * Turns `submit_verification` arguments into a verdict.
 *
 * `passed` is **computed here, not taken from the model**. A verifier that
 * reports a failing test and then ticks "passed" would otherwise let a broken
 * run through, and the one thing this gate cannot do is be talked into
 * success. The model reports observations; this decides what they mean.
 */
export function parseVerification(
  rawArgs: string,
  context: { attempt: number; conflictsDetected: boolean }
): VerificationParse {
  let parsed: unknown;
  try {
    parsed = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return {
      ok: false,
      error: `submit_verification arguments were not valid JSON: ${rawArgs.slice(0, 200)}`
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'submit_verification arguments were not an object.' };
  }

  const raw = parsed as Record<string, unknown>;
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) {
    return { ok: false, error: 'submit_verification was called without a summary.' };
  }

  const typecheck = parseCheck(raw.typecheck);
  const lint = parseCheck(raw.lint);
  const tests = parseCheck(raw.tests);
  const build = parseCheck(raw.build);
  const issues = parseIssues(raw.issues);
  const requiredFixes = parseFixes(raw.requiredFixes);
  const unexpectedChanges = asStringArray(raw.unexpectedChanges);
  const implementationCorrect = raw.implementationCorrect === true;

  const anyFailed = [typecheck, lint, tests, build].some((c) => c.outcome === 'failed');
  const hasBlocker = issues.some((i) => i.severity === 'blocker');

  const passed =
    implementationCorrect &&
    !anyFailed &&
    !hasBlocker &&
    unexpectedChanges.length === 0;

  return {
    ok: true,
    result: {
      passed,
      implementationCorrect,
      typecheck,
      lint,
      tests,
      build,
      unexpectedChanges,
      conflictsDetected: context.conflictsDetected,
      issues,
      requiredFixes,
      summary,
      attempt: context.attempt
    }
  };
}
