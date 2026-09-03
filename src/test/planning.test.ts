import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregatePlans,
  mergeRisks,
  mergeTesting,
  rankRelevantFiles,
  reconcileChanges,
  shouldProceed
} from '../agent/planning/aggregate';
import { PLANNERS, plannerById } from '../agent/planning/planners';
import { normaliseConfidence, parsePlan } from '../agent/planning/submitPlan';
import { AgentPlan } from '../agent/planning/types';

const CTX = {
  agentId: 'planner-1',
  role: 'planner' as const,
  planner: 'repository',
  objective: 'Repository Agent'
};

function plan(overrides: Partial<AgentPlan>): AgentPlan {
  return {
    agentId: 'a',
    role: 'planner',
    planner: 'p',
    objective: 'o',
    summary: 's',
    findings: [],
    relevantFiles: [],
    relevantSymbols: [],
    dependencies: [],
    proposedChanges: [],
    risks: [],
    testingStrategy: { existingTests: [], newTests: [], commands: [] },
    confidence: 0.8,
    ...overrides
  };
}

// --- planner definitions ---------------------------------------------------

test('planners are distinct and exactly one is critical', () => {
  const ids = PLANNERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'planner ids must be unique');

  const critical = PLANNERS.filter((p) => p.critical);
  assert.equal(critical.length, 1);
  assert.equal(
    critical[0].id,
    'repository',
    'without the repository sweep there is nothing to plan against'
  );
});

test('every planner has a label and a focus', () => {
  for (const p of PLANNERS) {
    assert.ok(p.label.length > 0, `${p.id} has no label`);
    assert.ok(p.focus.length > 100, `${p.id} has a thin focus prompt`);
    assert.equal(plannerById(p.id), p);
  }
  assert.equal(plannerById('nope'), undefined);
});

// --- parsing ---------------------------------------------------------------

test('a well-formed submission parses into a plan', () => {
  const parsed = parsePlan(
    JSON.stringify({
      summary: 'Auth lives in two files.',
      relevantFiles: ['src/auth/oauth.ts', 'src/auth/callback.ts'],
      proposedChanges: [
        {
          filePath: 'src/auth/callback.ts',
          kind: 'modify',
          rationale: 'validate the token'
        }
      ],
      confidence: 0.9
    }),
    CTX
  );

  assert.equal(parsed.ok, true);
  const p = parsed.ok ? parsed.plan : plan({});
  assert.equal(p.summary, 'Auth lives in two files.');
  assert.equal(p.relevantFiles.length, 2);
  assert.equal(p.proposedChanges[0].kind, 'modify');
  assert.equal(p.confidence, 0.9);
  assert.equal(p.planner, 'repository');
});

test('a submission without a summary is rejected', () => {
  const parsed = parsePlan(JSON.stringify({ confidence: 0.9 }), CTX);
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.error, /without a summary/);
});

test('invalid JSON is reported rather than thrown', () => {
  const parsed = parsePlan('{not json', CTX);
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : parsed.error, /not valid JSON/);
});

test('a malformed sub-field is dropped, not the whole plan', () => {
  // A planner that got one risk entry wrong has still done useful work.
  const parsed = parsePlan(
    JSON.stringify({
      summary: 'ok',
      confidence: 0.7,
      risks: [
        { description: 'real risk', severity: 'high' },
        { severity: 'high' },
        null
      ],
      findings: [{ content: 'real finding', type: 'nonsense' }, { files: [] }],
      proposedChanges: [
        { filePath: 'a.ts', kind: 'modify', rationale: 'r' },
        { kind: 'modify' }
      ]
    }),
    CTX
  );

  assert.equal(parsed.ok, true);
  const p = parsed.ok ? parsed.plan : plan({});
  assert.equal(p.risks.length, 1, 'entries without a description are dropped');
  assert.equal(p.findings.length, 1, 'entries without content are dropped');
  assert.equal(
    p.findings[0].type,
    'fact',
    'an unknown finding type falls back to fact'
  );
  assert.equal(p.proposedChanges.length, 1, 'changes without a path are dropped');
});

test('confidence is clamped, and a percentage is read as one', () => {
  assert.equal(normaliseConfidence(0.75), 0.75);
  assert.equal(normaliseConfidence(85), 0.85, 'a model that reports 85 means 85%');
  assert.equal(normaliseConfidence(100), 1);
  assert.equal(normaliseConfidence(-3), 0);
  assert.equal(
    normaliseConfidence('nonsense'),
    0.5,
    'unreadable confidence is mid, not zero'
  );
  assert.equal(normaliseConfidence(undefined), 0.5);
});

test('duplicate and blank paths are cleaned up', () => {
  const parsed = parsePlan(
    JSON.stringify({
      summary: 'ok',
      confidence: 1,
      relevantFiles: ['a.ts', 'a.ts', '  b.ts  ', '', '   ', 42]
    }),
    CTX
  );
  assert.deepEqual(parsed.ok ? parsed.plan.relevantFiles : [], ['a.ts', 'b.ts']);
});

// --- relevance ranking -----------------------------------------------------

test('files cited by more planners rank higher', () => {
  const ranked = rankRelevantFiles([
    plan({ relevantFiles: ['src/auth.ts', 'src/rare.ts'] }),
    plan({ relevantFiles: ['src/auth.ts', 'src/api.ts'] }),
    plan({ relevantFiles: ['src/auth.ts'] })
  ]);

  assert.equal(ranked[0], 'src/auth.ts', 'three independent planners found it');
  assert.equal(ranked.length, 3);
});

test('a file counted once per plan, however often that plan cites it', () => {
  const ranked = rankRelevantFiles([
    // Mentions auth.ts twice — in relevantFiles and again in a change — but
    // that is one planner's opinion, so it must count as one vote.
    plan({
      relevantFiles: ['src/auth.ts'],
      proposedChanges: [
        { filePath: 'src/auth.ts', kind: 'modify', rationale: 'x' },
        { filePath: 'src/other.ts', kind: 'modify', rationale: 'y' }
      ]
    }),
    plan({ relevantFiles: ['src/other.ts'] })
  ]);

  // other.ts has two genuine votes, auth.ts one. Were the repeat counted,
  // auth.ts would tie at two and win the tie-break on first-seen.
  assert.deepEqual(ranked, ['src/other.ts', 'src/auth.ts']);
});

test('paths are normalised so one file is not ranked twice', () => {
  const ranked = rankRelevantFiles([
    plan({ relevantFiles: ['src/auth.ts'] }),
    plan({ relevantFiles: ['./src/auth.ts'] }),
    plan({ relevantFiles: ['src\\auth.ts'] })
  ]);
  assert.deepEqual(ranked, ['src/auth.ts']);
});

// --- conflict detection ----------------------------------------------------

test('planners agreeing on a file is not a conflict', () => {
  const { changes, conflicts } = reconcileChanges([
    plan({
      planner: 'a',
      proposedChanges: [{ filePath: 'x.ts', kind: 'modify', rationale: 'r1' }]
    }),
    plan({
      planner: 'b',
      proposedChanges: [{ filePath: 'x.ts', kind: 'modify', rationale: 'r2' }]
    })
  ]);

  assert.equal(conflicts.length, 0);
  assert.equal(changes.length, 1);
  assert.match(changes[0].rationale, /r1/);
  assert.match(changes[0].rationale, /r2/, 'both rationales are kept');
});

test('planners disagreeing about the operation is a conflict', () => {
  const { changes, conflicts } = reconcileChanges([
    plan({
      planner: 'arch',
      proposedChanges: [{ filePath: 'x.ts', kind: 'modify', rationale: 'patch it' }]
    }),
    plan({
      planner: 'sec',
      proposedChanges: [{ filePath: 'x.ts', kind: 'delete', rationale: 'remove it' }]
    })
  ]);

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].filePath, 'x.ts');
  assert.equal(conflicts[0].positions.length, 2);
  assert.match(conflicts[0].description, /modify vs delete|delete vs modify/);
  // The run can still proceed; the conflict is surfaced alongside the choice.
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'delete', 'the most consequential operation wins');
});

test('confidence breaks a tie between equally consequential operations', () => {
  const { changes } = reconcileChanges([
    plan({
      planner: 'low',
      confidence: 0.2,
      proposedChanges: [{ filePath: 'x.ts', kind: 'modify', rationale: 'unsure' }]
    }),
    plan({
      planner: 'high',
      confidence: 0.95,
      proposedChanges: [{ filePath: 'x.ts', kind: 'modify', rationale: 'certain' }]
    })
  ]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'modify');
});

// --- risk and testing merge ------------------------------------------------

test('the same risk from two planners keeps the higher severity and both files', () => {
  const merged = mergeRisks([
    plan({
      risks: [{ severity: 'low', description: 'Token not validated', files: ['a.ts'] }]
    }),
    plan({
      risks: [{ severity: 'high', description: 'token not validated', files: ['b.ts'] }]
    })
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].severity, 'high');
  assert.deepEqual(merged[0].files.sort(), ['a.ts', 'b.ts']);
});

test('risks are ordered by severity', () => {
  const merged = mergeRisks([
    plan({
      risks: [
        { severity: 'low', description: 'minor', files: [] },
        { severity: 'high', description: 'major', files: [] },
        { severity: 'medium', description: 'middling', files: [] }
      ]
    })
  ]);
  assert.deepEqual(
    merged.map((r) => r.severity),
    ['high', 'medium', 'low']
  );
});

test('testing strategies union without duplicates', () => {
  const merged = mergeTesting([
    plan({
      testingStrategy: {
        existingTests: ['a.test.ts'],
        newTests: [],
        commands: ['npm test']
      }
    }),
    plan({
      testingStrategy: {
        existingTests: ['a.test.ts', 'b.test.ts'],
        newTests: ['c.test.ts'],
        commands: ['npm test']
      }
    })
  ]);

  assert.deepEqual(merged.existingTests.sort(), ['a.test.ts', 'b.test.ts']);
  assert.deepEqual(merged.newTests, ['c.test.ts']);
  assert.deepEqual(merged.commands, ['npm test']);
});

// --- aggregation and the proceed decision ----------------------------------

test('aggregate confidence is the mean of contributing plans', () => {
  const aggregate = aggregatePlans([
    plan({
      confidence: 1,
      proposedChanges: [{ filePath: 'a.ts', kind: 'modify', rationale: 'r' }]
    }),
    plan({
      confidence: 0.5,
      proposedChanges: [{ filePath: 'a.ts', kind: 'modify', rationale: 'r' }]
    })
  ]);
  assert.equal(aggregate.confidence, 0.75);
});

test('failures are carried through rather than hidden', () => {
  const aggregate = aggregatePlans(
    [
      plan({
        planner: 'repository',
        proposedChanges: [{ filePath: 'a.ts', kind: 'modify', rationale: 'r' }]
      })
    ],
    [{ planner: 'security', reason: 'timed out' }]
  );

  assert.equal(aggregate.failures.length, 1);
  assert.match(aggregate.summary, /security/);
});

test('a partial planning result can still proceed', () => {
  const aggregate = aggregatePlans(
    [
      plan({
        confidence: 0.8,
        proposedChanges: [{ filePath: 'a.ts', kind: 'modify', rationale: 'r' }]
      })
    ],
    [{ planner: 'security', reason: 'failed' }]
  );

  const decision = shouldProceed(aggregate, { criticalFailures: [] });
  assert.equal(
    decision.proceed,
    true,
    'one non-critical failure must not sink the run'
  );
});

test('a critical planner failing stops the run', () => {
  const aggregate = aggregatePlans([
    plan({ proposedChanges: [{ filePath: 'a.ts', kind: 'modify', rationale: 'r' }] })
  ]);
  const decision = shouldProceed(aggregate, { criticalFailures: ['repository'] });

  assert.equal(decision.proceed, false);
  assert.match(decision.reason, /repository/);
});

test('no plans at all stops the run', () => {
  const decision = shouldProceed(
    aggregatePlans([], [{ planner: 'repository', reason: 'x' }])
  );
  assert.equal(decision.proceed, false);
});

test('planners finding nothing to change stops rather than inventing work', () => {
  const decision = shouldProceed(aggregatePlans([plan({ confidence: 0.9 })]));
  assert.equal(decision.proceed, false);
  assert.match(decision.reason, /did not identify any file/);
});

test('uniformly low confidence stops rather than guessing', () => {
  const aggregate = aggregatePlans([
    plan({
      confidence: 0.1,
      proposedChanges: [{ filePath: 'a.ts', kind: 'modify', rationale: 'r' }]
    }),
    plan({
      confidence: 0.2,
      proposedChanges: [{ filePath: 'a.ts', kind: 'modify', rationale: 'r' }]
    })
  ]);

  const decision = shouldProceed(aggregate);
  assert.equal(decision.proceed, false);
  assert.match(decision.reason, /low confidence/);
});

test('an empty aggregate is well-formed rather than throwing', () => {
  const aggregate = aggregatePlans([]);
  assert.deepEqual(aggregate.relevantFiles, []);
  assert.deepEqual(aggregate.changes, []);
  assert.equal(aggregate.confidence, 0);
  assert.ok(aggregate.summary.length > 0);
});
