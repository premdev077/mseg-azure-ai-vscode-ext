import * as assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * The phase runner reaches `tools.ts` for the planners' read tools, and that
 * imports `vscode`. Stubbed here so parallel planning can be exercised in
 * plain Node; the planners in these tests submit without reading, so the stub
 * only has to satisfy module load.
 */
interface LoaderInternals {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}
const loader = require('node:module') as LoaderInternals;
const originalLoad = loader._load;
loader._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: { workspaceFolders: [], findFiles: async () => [], fs: {} },
      languages: { getDiagnostics: () => [] },
      DiagnosticSeverity: { Error: 0, Warning: 1 },
      Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
      RelativePattern: class {}
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

import { Budget } from '../agent/budget';
import { PlannerSpec } from '../agent/planning/types';

const { renderPlanBrief, runPlanningPhase } =
  require('../agent/planning/phase') as typeof import('../agent/planning/phase');
import { aggregatePlans } from '../agent/planning/aggregate';
import { DEFAULT_CONCURRENCY } from '../agent/scheduler';
import { EventBus } from '../events/bus';
import { AIModelProvider, ChatRequest } from '../ai/provider';
import { StreamResult } from '../azureClient';

/**
 * `runPlanningPhase` reaches the model only through `AIModelProvider` and the
 * workspace only through `ToolContext`, so both are substituted here. That is
 * the whole benefit of the provider abstraction: parallel planning is testable
 * without Azure, a workspace or the extension host.
 */
function fakeProvider(
  reply: (request: ChatRequest, call: number) => Partial<StreamResult>
): AIModelProvider & { calls: number } {
  const provider = {
    id: 'fake',
    displayName: 'Fake',
    calls: 0,
    listModels: () => ['fake-model'],
    supportsToolCalling: () => true,
    supportsReasoning: () => true,
    async stream(request: ChatRequest): Promise<StreamResult> {
      provider.calls += 1;
      const partial = reply(request, provider.calls);
      return {
        content: '',
        reasoning: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: { prompt_tokens: 100, completion_tokens: 20 },
        ...partial
      };
    },
    async chat(request: ChatRequest): Promise<StreamResult> {
      return provider.stream(request);
    }
  };
  return provider;
}

function submitCall(args: Record<string, unknown>, id = 'call-1') {
  return {
    id,
    type: 'function' as const,
    function: { name: 'submit_plan', arguments: JSON.stringify(args) }
  };
}

const SETTINGS = {
  models: ['fake-model'],
  deployment: 'fake-model',
  modelRoles: {}
} as never;

const TOOL_CONTEXT = {
  settings: SETTINGS,
  edits: {} as never,
  commands: {} as never,
  recorder: { add: () => undefined } as never,
  onEditProposed: () => undefined,
  onCommandProposed: () => undefined,
  onCommandFinished: () => undefined,
  token: { isCancellationRequested: false } as never
};

function baseOptions(provider: AIModelProvider, planners: readonly PlannerSpec[]) {
  return {
    request: 'Fix the authentication callback.',
    basePrompt: 'You are an engineer.',
    taskId: 'task-1',
    settings: SETTINGS,
    provider,
    bus: new EventBus(),
    budget: new Budget(),
    concurrency: DEFAULT_CONCURRENCY,
    toolContext: TOOL_CONTEXT,
    signal: new AbortController().signal,
    token: { isCancellationRequested: false } as never,
    planners
  };
}

const PLANNER = (id: string, critical = false): PlannerSpec => ({
  id,
  label: `${id} Agent`,
  critical,
  focus: `focus for ${id}`
});

// --- parallel execution ----------------------------------------------------

test('planners run concurrently, not one after another', async () => {
  let inFlight = 0;
  let peak = 0;

  const provider = fakeProvider(() => ({}));
  const original = provider.stream.bind(provider);
  provider.stream = async (request, handlers, signal) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return {
      ...(await original(request, handlers, signal)),
      toolCalls: [
        submitCall({
          summary: 'done',
          confidence: 0.8,
          proposedChanges: [{ filePath: 'a.ts', kind: 'modify', rationale: 'r' }]
        })
      ]
    };
  };

  const planners = [PLANNER('a'), PLANNER('b'), PLANNER('c'), PLANNER('d')];
  const result = await runPlanningPhase(baseOptions(provider, planners));

  assert.equal(peak, 4, `expected all four planners in flight at once, saw ${peak}`);
  assert.equal(result.aggregate.plans.length, 4);
});

test('the planning concurrency limit is respected', async () => {
  let inFlight = 0;
  let peak = 0;

  const provider = fakeProvider(() => ({}));
  provider.stream = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 3));
    inFlight -= 1;
    return {
      content: '',
      reasoning: '',
      finishReason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 2 },
      toolCalls: [
        submitCall({
          summary: 's',
          confidence: 0.8,
          proposedChanges: [{ filePath: 'a.ts', kind: 'modify', rationale: 'r' }]
        })
      ]
    };
  };

  const options = {
    ...baseOptions(provider, [
      PLANNER('a'),
      PLANNER('b'),
      PLANNER('c'),
      PLANNER('d'),
      PLANNER('e')
    ]),
    concurrency: { ...DEFAULT_CONCURRENCY, maxPlanningAgents: 2 }
  };
  await runPlanningPhase(options);

  assert.ok(peak <= 2, `planning concurrency was ${peak}, limit was 2`);
});

test('each planner gets only read-only tools plus submit_plan', async () => {
  const seen: string[][] = [];
  const provider = fakeProvider((request) => {
    seen.push(request.tools.map((t) => t.function.name));
    return {
      toolCalls: [
        submitCall({
          summary: 's',
          confidence: 0.8,
          proposedChanges: [{ filePath: 'a.ts', kind: 'modify', rationale: 'r' }]
        })
      ]
    };
  });

  await runPlanningPhase(baseOptions(provider, [PLANNER('a')]));

  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes('submit_plan'));
  assert.ok(seen[0].includes('read_file'));
  for (const mutating of [
    'write_file',
    'apply_patch',
    'run_command',
    'run_validation'
  ]) {
    assert.ok(
      !seen[0].includes(mutating),
      `a planner must not be given ${mutating} — it is read-only by construction`
    );
  }
});

// --- partial failure -------------------------------------------------------

test('one planner failing does not sink the run', async () => {
  const provider = fakeProvider((request) => {
    const system = String(request.messages[0].content);
    if (system.includes('focus for security')) {
      // Returns no tool calls at all, repeatedly: it never submits.
      return { toolCalls: [] };
    }
    return {
      toolCalls: [
        submitCall({
          summary: 'ok',
          confidence: 0.8,
          proposedChanges: [{ filePath: 'a.ts', kind: 'modify', rationale: 'r' }]
        })
      ]
    };
  });

  const result = await runPlanningPhase(
    baseOptions(provider, [PLANNER('repository', true), PLANNER('security')])
  );

  assert.equal(result.aggregate.plans.length, 1);
  assert.equal(result.aggregate.failures.length, 1);
  assert.equal(result.aggregate.failures[0].planner, 'security');
  assert.equal(result.proceed, true, 'a non-critical failure must not stop the run');
});

test('the critical planner failing stops the run', async () => {
  const provider = fakeProvider((request) => {
    const system = String(request.messages[0].content);
    if (system.includes('focus for repository')) {
      return { toolCalls: [] };
    }
    return {
      toolCalls: [
        submitCall({
          summary: 'ok',
          confidence: 0.9,
          proposedChanges: [{ filePath: 'a.ts', kind: 'modify', rationale: 'r' }]
        })
      ]
    };
  });

  const result = await runPlanningPhase(
    baseOptions(provider, [PLANNER('repository', true), PLANNER('security')])
  );

  assert.deepEqual(result.criticalFailures, ['repository']);
  assert.equal(result.proceed, false);
  assert.match(result.reason, /repository/);
});

test('a provider error is captured as a planner failure, not a crash', async () => {
  const provider = fakeProvider(() => {
    throw new Error('429 rate limited');
  });

  const result = await runPlanningPhase(baseOptions(provider, [PLANNER('a')]));
  assert.equal(result.aggregate.failures.length, 1);
  assert.match(result.aggregate.failures[0].reason, /429/);
});

test('a malformed submission is fed back once and can recover', async () => {
  const provider = fakeProvider((_request, call) =>
    call === 1
      ? { toolCalls: [submitCall({ confidence: 0.9 })] } // no summary
      : {
          toolCalls: [
            submitCall({
              summary: 'second time lucky',
              confidence: 0.9,
              proposedChanges: [{ filePath: 'a.ts', kind: 'modify', rationale: 'r' }]
            })
          ]
        }
  );

  const result = await runPlanningPhase(baseOptions(provider, [PLANNER('a')]));
  assert.equal(result.aggregate.plans.length, 1);
  assert.equal(result.aggregate.plans[0].summary, 'second time lucky');
  assert.equal(provider.calls, 2);
});

// --- budget and ordering ---------------------------------------------------

test('planning spend is charged to the run budget', async () => {
  const provider = fakeProvider(() => ({
    usage: { prompt_tokens: 2000, completion_tokens: 300 },
    toolCalls: [
      submitCall({
        summary: 's',
        confidence: 0.8,
        proposedChanges: [{ filePath: 'a.ts', kind: 'modify', rationale: 'r' }]
      })
    ]
  }));

  const options = baseOptions(provider, [PLANNER('a'), PLANNER('b')]);
  await runPlanningPhase(options);

  assert.equal(
    options.budget.usage().totalTokens,
    4600,
    'both planners should be charged'
  );
  assert.equal(options.budget.usage().agentsStarted, 2);
});

test('results are ordered by planner, not by who finished first', async () => {
  const provider = fakeProvider((request) => {
    const system = String(request.messages[0].content);
    const id = system.includes('focus for slow') ? 'slow' : 'fast';
    return {
      toolCalls: [
        submitCall({
          summary: id,
          confidence: 0.8,
          proposedChanges: [{ filePath: `${id}.ts`, kind: 'modify', rationale: 'r' }]
        })
      ]
    };
  });

  const originalStream = provider.stream.bind(provider);
  provider.stream = async (request, handlers, signal) => {
    if (String(request.messages[0].content).includes('focus for slow')) {
      await new Promise((r) => setTimeout(r, 15));
    }
    return originalStream(request, handlers, signal);
  };

  // "slow" is declared first but finishes last.
  const result = await runPlanningPhase(
    baseOptions(provider, [PLANNER('slow'), PLANNER('fast')])
  );

  assert.deepEqual(
    result.aggregate.plans.map((p) => p.planner),
    ['slow', 'fast'],
    'aggregate order must be deterministic'
  );
});

// --- the brief handed to implementation ------------------------------------

test('the plan brief carries the decisions an implementer needs', () => {
  const aggregate = aggregatePlans(
    [
      {
        agentId: 'a',
        role: 'planner',
        planner: 'repository',
        objective: 'o',
        summary: 'The callback does not validate its token.',
        findings: [],
        relevantFiles: ['src/auth/callback.ts'],
        relevantSymbols: ['handleOAuthCallback'],
        dependencies: [],
        proposedChanges: [
          {
            filePath: 'src/auth/callback.ts',
            kind: 'modify',
            rationale: 'validate the token'
          }
        ],
        risks: [
          {
            severity: 'high',
            description: 'Auth bypass',
            files: ['src/auth/callback.ts']
          }
        ],
        testingStrategy: {
          existingTests: ['tests/auth.test.ts'],
          newTests: [],
          commands: ['npm test']
        },
        confidence: 0.9
      }
    ],
    [{ planner: 'security', reason: 'timed out' }]
  );

  const brief = renderPlanBrief(aggregate);

  assert.match(brief, /# Plan/);
  assert.match(brief, /src\/auth\/callback\.ts/);
  assert.match(brief, /validate the token/);
  assert.match(brief, /\*\*high\*\* — Auth bypass/);
  assert.match(brief, /npm test/);
  // A partial analysis must say so, so nobody reads the brief as complete.
  assert.match(brief, /Incomplete analysis/);
  assert.match(brief, /security \(timed out\)/);
});

test('the brief states disagreements instead of hiding the resolution', () => {
  const aggregate = aggregatePlans([
    {
      agentId: 'a',
      role: 'planner',
      planner: 'architecture',
      objective: 'o',
      summary: 's',
      findings: [],
      relevantFiles: [],
      relevantSymbols: [],
      dependencies: [],
      proposedChanges: [{ filePath: 'x.ts', kind: 'modify', rationale: 'patch it' }],
      risks: [],
      testingStrategy: { existingTests: [], newTests: [], commands: [] },
      confidence: 0.8
    },
    {
      agentId: 'b',
      role: 'planner',
      planner: 'security',
      objective: 'o',
      summary: 's',
      findings: [],
      relevantFiles: [],
      relevantSymbols: [],
      dependencies: [],
      proposedChanges: [{ filePath: 'x.ts', kind: 'delete', rationale: 'remove it' }],
      risks: [],
      testingStrategy: { existingTests: [], newTests: [], commands: [] },
      confidence: 0.8
    }
  ]);

  const brief = renderPlanBrief(aggregate);
  assert.match(brief, /Unresolved disagreements/);
  assert.match(brief, /architecture wants to \*\*modify\*\* it/);
  assert.match(brief, /security wants to \*\*delete\*\* it/);
});

test('an empty aggregate still renders a readable brief', () => {
  const brief = renderPlanBrief(aggregatePlans([]));
  assert.ok(brief.startsWith('# Plan'));
  assert.ok(brief.length > 10);
});
