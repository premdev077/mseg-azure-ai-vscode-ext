import * as assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * End-to-end cover for the full pipeline: plan → implement → verify → repair.
 *
 * The model is scripted and the workspace is stubbed, so what is under test is
 * the *sequencing and the gate* — that planning failing stops the run, that a
 * failed verification produces repair work, that the attempt cap holds, and
 * above all that nothing reaches `completed` without a passing verification.
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

import { EventBus } from '../events/bus';
import { AIModelProvider, ChatRequest } from '../ai/provider';
import { StreamResult, ToolCall } from '../azureClient';

const { runMultiAgentTask } = require('../agent/run') as typeof import('../agent/run');

// The git layer shells out, which is not available here. Both entry points are
// replaced so the run sees a clean repository.
const capture = require('../git/capture') as typeof import('../git/capture');
(capture as { captureBaseline: unknown }).captureBaseline = async () => ({
  isRepo: true,
  branch: 'main',
  dirtyFiles: [],
  capturedAt: new Date().toISOString()
});
(capture as { currentStatus: unknown }).currentStatus = async () => [];

function call(
  name: string,
  args: Record<string, unknown>,
  id = `c-${Math.random()}`
): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const PLAN_ARGS = {
  summary: 'The callback needs token validation.',
  confidence: 0.9,
  relevantFiles: ['src/auth/callback.ts'],
  proposedChanges: [
    {
      filePath: 'src/auth/callback.ts',
      kind: 'modify',
      rationale: 'validate the token'
    }
  ]
};

interface Script {
  onPlan?: () => Partial<StreamResult>;
  onCode?: (round: number) => Partial<StreamResult>;
  onVerify?: (attempt: number) => Partial<StreamResult>;
}

/** Routes each call to the right script by what the system prompt says. */
function scriptedProvider(
  script: Script
): AIModelProvider & { verifyCalls: number; codeCalls: number } {
  const provider = {
    id: 'scripted',
    displayName: 'Scripted',
    verifyCalls: 0,
    codeCalls: 0,
    listModels: () => ['m'],
    supportsToolCalling: () => true,
    supportsReasoning: () => true,
    async stream(request: ChatRequest): Promise<StreamResult> {
      const system = String(request.messages[0].content);
      const base: StreamResult = {
        content: '',
        reasoning: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: { prompt_tokens: 100, completion_tokens: 10 }
      };

      // Order matters: the coder prompt *mentions* the Verification Agent, so
      // the coder branch is matched first and both use the bolded self-
      // description rather than a bare substring.
      if (
        system.includes('an **Implementation Agent**') ||
        system.includes('a **Repair Agent**')
      ) {
        provider.codeCalls += 1;
        return {
          ...base,
          ...(script.onCode?.(provider.codeCalls) ?? { content: 'done' })
        };
      }
      if (system.includes('You are the **Verification Agent**')) {
        provider.verifyCalls += 1;
        return { ...base, ...(script.onVerify?.(provider.verifyCalls) ?? {}) };
      }
      return {
        ...base,
        ...(script.onPlan?.() ?? { toolCalls: [call('submit_plan', PLAN_ARGS)] })
      };
    },
    async chat(request: ChatRequest): Promise<StreamResult> {
      return provider.stream(request);
    }
  };
  return provider as AIModelProvider & { verifyCalls: number; codeCalls: number };
}

const SETTINGS = {
  models: ['m'],
  deployment: 'm',
  modelRoles: {},
  budget: {},
  concurrency: {}
} as never;

function options(provider: AIModelProvider, extra: Record<string, unknown> = {}) {
  return {
    request: 'Fix the authentication callback.',
    taskId: 'task-1',
    workspaceRoot: '/repo',
    settings: SETTINGS,
    provider,
    bus: new EventBus(),
    toolContext: {
      settings: SETTINGS,
      edits: {} as never,
      commands: {} as never,
      recorder: { add: () => undefined } as never,
      onEditProposed: () => undefined,
      onCommandProposed: () => undefined,
      onCommandFinished: () => undefined,
      token: { isCancellationRequested: false } as never
    },
    signal: new AbortController().signal,
    token: { isCancellationRequested: false } as never,
    planners: undefined,
    ...extra
  } as never;
}

const PASS = {
  implementationCorrect: true,
  summary: 'Correct and checks pass.',
  typecheck: { outcome: 'passed', detail: 'clean' },
  tests: { outcome: 'passed', detail: '12 passed' }
};

const FAIL = {
  implementationCorrect: false,
  summary: 'A type error remains.',
  typecheck: { outcome: 'failed', detail: '1 error' },
  tests: { outcome: 'failed', detail: '1 failed' },
  issues: [
    { severity: 'blocker', description: 'Type error', files: ['src/auth/callback.ts'] }
  ],
  requiredFixes: [
    {
      objective: 'Fix the type error',
      files: ['src/auth/callback.ts'],
      rationale: 'tsc fails'
    }
  ]
};

// --- the happy path --------------------------------------------------------

test('a verified run completes', async () => {
  const provider = scriptedProvider({
    onVerify: () => ({ toolCalls: [call('submit_verification', PASS)] })
  });

  const result = await runMultiAgentTask(options(provider));

  assert.equal(result.state, 'completed');
  assert.match(result.report, /completed and verified/i);
  assert.match(result.report, /VERIFIED/);
  assert.equal(result.attempts, 1);
});

test('the phases run in order and emit a traceable stream', async () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.on((e) => seen.push(e.type));

  const provider = scriptedProvider({
    onVerify: () => ({ toolCalls: [call('submit_verification', PASS)] })
  });
  await runMultiAgentTask(options(provider, { bus }));

  const first = (type: string) => seen.indexOf(type);
  assert.ok(first('planning.started') >= 0, 'planning must be emitted');
  assert.ok(
    first('verification.started') > first('planning.completed'),
    'verification must follow planning'
  );
  assert.ok(seen.includes('verification.completed'));
});

// --- the gate --------------------------------------------------------------

test('a failing verification never reports completed', async () => {
  const provider = scriptedProvider({
    onVerify: () => ({ toolCalls: [call('submit_verification', FAIL)] })
  });

  const result = await runMultiAgentTask(
    options(provider, { maxVerificationAttempts: 1 })
  );

  assert.notEqual(result.state, 'completed');
  assert.equal(result.state, 'failed');
  assert.match(result.report, /could not be verified/);
  assert.match(result.report, /was not marked complete/);
});

test('a verifier that cannot report fails the run rather than passing it', async () => {
  const provider = scriptedProvider({
    // Never calls submit_verification.
    onVerify: () => ({ content: 'I think it is probably fine.' })
  });

  const result = await runMultiAgentTask(
    options(provider, { maxVerificationAttempts: 1 })
  );
  assert.equal(result.state, 'failed');
  assert.equal(result.verification?.passed, false);
});

// --- the repair loop -------------------------------------------------------

test('a failed verification produces repair work and re-verifies', async () => {
  const provider = scriptedProvider({
    onVerify: (attempt) => ({
      toolCalls: [call('submit_verification', attempt === 1 ? FAIL : PASS)]
    })
  });

  const result = await runMultiAgentTask(options(provider));

  assert.equal(result.state, 'completed', 'the repair should have fixed it');
  assert.equal(result.attempts, 2);
  assert.equal(provider.verifyCalls, 2, 'verification must run again after repair');
});

test('the attempt cap stops the loop instead of running forever', async () => {
  const provider = scriptedProvider({
    onVerify: () => ({ toolCalls: [call('submit_verification', FAIL)] })
  });

  const result = await runMultiAgentTask(
    options(provider, { maxVerificationAttempts: 3 })
  );

  assert.equal(result.state, 'failed');
  assert.equal(result.attempts, 3);
  assert.equal(provider.verifyCalls, 3, 'exactly the cap, no more');
  assert.match(result.report, /Attempts: 3 of 3/);
});

test('repair agents are given the verifier findings', async () => {
  const objectives: string[] = [];
  const provider = scriptedProvider({
    onCode: () => ({ content: 'done' }),
    onVerify: (attempt) => ({
      toolCalls: [call('submit_verification', attempt === 1 ? FAIL : PASS)]
    })
  });

  const original = provider.stream.bind(provider);
  provider.stream = async (request, handlers, signal) => {
    const system = String(request.messages[0].content);
    if (system.includes('a **Repair Agent**')) {
      objectives.push(String(request.messages[1].content));
    }
    return original(request, handlers, signal);
  };

  await runMultiAgentTask(options(provider));

  assert.equal(objectives.length, 1);
  assert.match(objectives[0], /Fix the type error/);
  assert.match(objectives[0], /tsc fails/);
  assert.match(objectives[0], /Do not weaken a test/);
});

// --- stopping early --------------------------------------------------------

test('planning finding nothing to change stops before any agent edits', async () => {
  const provider = scriptedProvider({
    onPlan: () => ({
      toolCalls: [
        call('submit_plan', { summary: 'Nothing to do here.', confidence: 0.9 })
      ]
    })
  });

  const result = await runMultiAgentTask(options(provider));

  assert.equal(result.state, 'failed');
  assert.equal(provider.codeCalls, 0, 'no implementation agent should have run');
  assert.equal(provider.verifyCalls, 0, 'nothing to verify');
  assert.match(result.report, /not started/);
});

test('a cancelled run reports what was already applied', async () => {
  const token = { isCancellationRequested: false };
  const provider = scriptedProvider({
    onPlan: () => {
      token.isCancellationRequested = true;
      return { toolCalls: [call('submit_plan', PLAN_ARGS)] };
    }
  });

  const result = await runMultiAgentTask(options(provider, { token }));

  assert.equal(result.state, 'cancelled');
  assert.match(result.report, /cancelled/i);
});

// --- honesty ---------------------------------------------------------------

test('the report never claims a check passed that was not run', async () => {
  const provider = scriptedProvider({
    onVerify: () => ({
      toolCalls: [
        call('submit_verification', {
          implementationCorrect: true,
          summary: 'This project has no tests.',
          typecheck: { outcome: 'passed', detail: 'clean' }
        })
      ]
    })
  });

  const result = await runMultiAgentTask(options(provider));

  assert.equal(result.state, 'completed');
  assert.equal(result.verification?.tests.outcome, 'skipped');
  assert.match(result.report, /– Tests/, 'a skipped check must not render as a tick');
});

test('budget spend is reported', async () => {
  const provider = scriptedProvider({
    onVerify: () => ({ toolCalls: [call('submit_verification', PASS)] })
  });

  const result = await runMultiAgentTask(options(provider));
  assert.match(result.budget, /tokens/);
  assert.match(result.report, /Budget:/);
});
