import { ToolSpec } from '../../azureClient';
import { AgentRole } from '../roles';
import {
  AgentPlan,
  ChangeKind,
  Finding,
  FindingType,
  ProposedChange,
  Risk,
  RiskSeverity,
  TestingStrategy
} from './types';

/**
 * A planner returns its plan by calling a tool rather than writing JSON into
 * its reply.
 *
 * The model is already reliable at emitting tool arguments against a schema,
 * and the alternative — asking for JSON in prose and parsing it out — fails on
 * fenced code blocks, trailing commentary and truncation. This way the
 * transport is the one the provider already validates, and everything below is
 * about defending against a model that fills the schema loosely.
 */
export const SUBMIT_PLAN_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'submit_plan',
    description:
      'Submit your analysis. Call this exactly once, when you have finished inspecting the repository. Everything you report must come from what you actually read — do not speculate about files you did not open.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'Two or three sentences: what you found and what you think should happen.'
        },
        findings: {
          type: 'array',
          description: 'Specific things you established, each tied to real files.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['fact', 'dependency', 'risk', 'recommendation']
              },
              content: { type: 'string', description: 'One sentence.' },
              files: {
                type: 'array',
                items: { type: 'string' },
                description: 'Workspace-relative paths this finding concerns.'
              },
              confidence: {
                type: 'number',
                description: '0 to 1. Be honest — a low number is useful information.'
              }
            },
            required: ['type', 'content']
          }
        },
        relevantFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Workspace-relative paths that matter for this task.'
        },
        relevantSymbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Functions, classes, types or endpoints that matter.'
        },
        dependencies: {
          type: 'array',
          items: { type: 'string' },
          description: 'Packages or modules the work depends on.'
        },
        proposedChanges: {
          type: 'array',
          description: 'The edits you believe are needed. One entry per file.',
          items: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
              kind: { type: 'string', enum: ['create', 'modify', 'delete'] },
              rationale: { type: 'string', description: 'Why this file must change.' }
            },
            required: ['filePath', 'kind', 'rationale']
          }
        },
        risks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: { type: 'string', enum: ['low', 'medium', 'high'] },
              description: { type: 'string' },
              files: { type: 'array', items: { type: 'string' } }
            },
            required: ['severity', 'description']
          }
        },
        testingStrategy: {
          type: 'object',
          properties: {
            existingTests: {
              type: 'array',
              items: { type: 'string' },
              description: 'Test files that already cover this code.'
            },
            newTests: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tests that should be added or updated.'
            },
            commands: {
              type: 'array',
              items: { type: 'string' },
              description: 'Verification commands you confirmed exist in this project.'
            }
          }
        },
        confidence: {
          type: 'number',
          description:
            '0 to 1, your confidence in this analysis overall. Say so honestly if you could not inspect enough.'
        }
      },
      required: ['summary', 'confidence']
    }
  }
};

const FINDING_TYPES: FindingType[] = ['fact', 'dependency', 'risk', 'recommendation'];
const CHANGE_KINDS: ChangeKind[] = ['create', 'modify', 'delete'];
const SEVERITIES: RiskSeverity[] = ['low', 'medium', 'high'];

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      out.push(item.trim());
    }
  }
  return [...new Set(out)];
}

/** Clamps to 0–1. A model that reports 95 means 0.95, not 95. */
export function normaliseConfidence(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    return 0.5;
  }
  if (n > 1 && n <= 100) {
    return Math.min(1, n / 100);
  }
  return Math.min(1, Math.max(0, n));
}

function parseFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Finding[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const raw = item as Record<string, unknown>;
    const content = typeof raw.content === 'string' ? raw.content.trim() : '';
    if (!content) {
      continue;
    }
    const type = FINDING_TYPES.includes(raw.type as FindingType)
      ? (raw.type as FindingType)
      : 'fact';
    out.push({
      type,
      content,
      files: asStringArray(raw.files),
      confidence: normaliseConfidence(raw.confidence)
    });
  }
  return out;
}

function parseChanges(value: unknown): ProposedChange[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ProposedChange[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const raw = item as Record<string, unknown>;
    const filePath = typeof raw.filePath === 'string' ? raw.filePath.trim() : '';
    if (!filePath) {
      continue;
    }
    out.push({
      filePath,
      kind: CHANGE_KINDS.includes(raw.kind as ChangeKind)
        ? (raw.kind as ChangeKind)
        : 'modify',
      rationale:
        typeof raw.rationale === 'string' && raw.rationale.trim()
          ? raw.rationale.trim()
          : '(no rationale given)'
    });
  }
  return out;
}

function parseRisks(value: unknown): Risk[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Risk[] = [];
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
      severity: SEVERITIES.includes(raw.severity as RiskSeverity)
        ? (raw.severity as RiskSeverity)
        : 'medium',
      description,
      files: asStringArray(raw.files)
    });
  }
  return out;
}

function parseTesting(value: unknown): TestingStrategy {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    existingTests: asStringArray(raw.existingTests),
    newTests: asStringArray(raw.newTests),
    commands: asStringArray(raw.commands)
  };
}

export type PlanParse = { ok: true; plan: AgentPlan } | { ok: false; error: string };

/**
 * Turns raw `submit_plan` arguments into a plan.
 *
 * Every field except the summary is recovered leniently: a planner that
 * returns a malformed risk entry has still done useful work, and discarding
 * the whole plan over it would waste a model call. Only a missing summary is
 * fatal, because a plan nobody can read is not a plan.
 */
export function parsePlan(
  rawArgs: string,
  context: { agentId: string; role: AgentRole; planner: string; objective: string }
): PlanParse {
  let parsed: unknown;
  try {
    parsed = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return {
      ok: false,
      error: `submit_plan arguments were not valid JSON: ${rawArgs.slice(0, 200)}`
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'submit_plan arguments were not an object.' };
  }

  const raw = parsed as Record<string, unknown>;
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) {
    return { ok: false, error: 'submit_plan was called without a summary.' };
  }

  return {
    ok: true,
    plan: {
      agentId: context.agentId,
      role: context.role,
      planner: context.planner,
      objective: context.objective,
      summary,
      findings: parseFindings(raw.findings),
      relevantFiles: asStringArray(raw.relevantFiles),
      relevantSymbols: asStringArray(raw.relevantSymbols),
      dependencies: asStringArray(raw.dependencies),
      proposedChanges: parseChanges(raw.proposedChanges),
      risks: parseRisks(raw.risks),
      testingStrategy: parseTesting(raw.testingStrategy),
      confidence: normaliseConfidence(raw.confidence)
    }
  };
}
