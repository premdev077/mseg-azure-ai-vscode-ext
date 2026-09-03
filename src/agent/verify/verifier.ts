import * as vscode from 'vscode';
import { AIModelProvider } from '../../ai/provider';
import { ChatMessage, ToolSpec } from '../../azureClient';
import { Settings } from '../../config';
import { EventBus } from '../../events/bus';
import { runTool, TOOL_SPECS, ToolContext } from '../../tools';
import { ChangeLog } from '../changes';
import { resolveRoleModel } from '../roles';
import { parseVerification, SUBMIT_VERIFICATION_TOOL } from './submitVerification';
import { unverified, VerificationResult } from './types';

/** Rounds the verifier gets to inspect before it must report. */
const MAX_VERIFIER_ROUNDS = 14;

/**
 * What the verifier may call.
 *
 * It reads, it runs the project's checks, and it reads the diff — but it
 * cannot edit. A verifier that could fix what it found would be certifying its
 * own work, which is the thing this agent exists to prevent.
 */
const VERIFIER_TOOLS = [
  'read_file',
  'list_files',
  'search_workspace',
  'get_diagnostics',
  'git_status',
  'git_diff',
  'run_validation'
];

export interface VerifierOptions {
  request: string;
  planBrief?: string;
  changes: ChangeLog;
  /** Files that changed but no task claimed, from the git baseline. */
  unexpectedChanges: string[];
  conflictsDetected: boolean;
  attempt: number;
  taskId: string;
  agentId: string;
  settings: Settings;
  provider: AIModelProvider;
  bus: EventBus;
  toolContext: Omit<ToolContext, 'owner'>;
  signal: AbortSignal;
  token: vscode.CancellationToken;
  onUsage?: (usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  }) => void;
}

function buildVerifierPrompt(options: VerifierOptions): string {
  const changed = options.changes.changedFiles();
  const rejected = options.changes.rejected();

  return `You are the **Verification Agent**. You are the only agent that can declare this work complete, and you did not write any of it.

Your job is to establish, from the repository as it stands, whether the user's request was actually implemented and whether anything was broken doing it.

# What was asked

"""
${options.request}
"""

${options.planBrief ? `# The plan the agents worked to\n\n${options.planBrief}\n` : ''}
# What the agents report changing

${changed.length ? changed.map((f) => `- ${f}`).join('\n') : '- (nothing)'}
${
  rejected.length
    ? `\nEdits the user rejected, which must NOT be treated as applied:\n${rejected
        .map((r) => `- ${r.filePath}`)
        .join('\n')}\n`
    : ''
}${
    options.unexpectedChanges.length
      ? `\nFiles that changed but no task claimed:\n${options.unexpectedChanges
          .map((f) => `- ${f}`)
          .join('\n')}\n`
      : ''
  }
# How to verify

Do not take any of the above on trust. It is what the agents *claim*; your job is to check it.

1. Read \`git_diff\` and see what actually changed.
2. Open the changed files and read the change in context, not just the hunk.
3. Judge whether it does what the user asked. A change that compiles but does not implement the request is a failure.
4. Run \`run_validation\` and read the real output.
5. Use \`get_diagnostics\` on the changed files.
6. Look for damage: removed behaviour, broken callers, a check silenced rather than fixed, a test weakened to make it pass.
7. Call \`submit_verification\` once.

# Rules

- **Report only what you observed.** A check you did not run is \`skipped\`. Never report \`passed\` for something you did not see pass — the run's honesty depends entirely on this.
- You cannot edit files. If something needs fixing, describe it in \`requiredFixes\` precisely enough for another agent to act on without re-deriving your reasoning.
- Any file in the diff that no task claimed is a finding, however harmless it looks.
- Be specific. "Tests fail" is not useful; "tests/auth.test.ts:42 expects a string, gets undefined" is.
- If the work is good, say so plainly and pass it. Manufacturing objections is as unhelpful as missing real ones.`;
}

export type VerifierOutcome =
  { ok: true; result: VerificationResult } | { ok: false; error: string };

/**
 * Runs one verification pass.
 *
 * Uses the `verifier` model role, so this can be pointed at a stronger
 * deployment than the coders — it is the last thing standing between a broken
 * change and a run reporting success.
 */
export async function runVerifier(options: VerifierOptions): Promise<VerifierOutcome> {
  const tools: ToolSpec[] = [
    ...TOOL_SPECS.filter((t) => VERIFIER_TOOLS.includes(t.function.name)),
    SUBMIT_VERIFICATION_TOOL
  ];

  const model = resolveRoleModel(
    'verifier',
    options.settings.modelRoles,
    options.settings.models,
    options.settings.deployment
  ).model;

  const messages: ChatMessage[] = [
    { role: 'system', content: buildVerifierPrompt(options) },
    {
      role: 'user',
      content:
        'Verify this work now. Inspect the repository yourself, run the checks, then call submit_verification.'
    }
  ];

  options.bus.emit({
    type: 'verification.started',
    taskId: options.taskId,
    agentId: options.agentId,
    data: {
      attempt: options.attempt,
      model,
      files: options.changes.changedFiles().length
    }
  });

  for (let round = 0; round < MAX_VERIFIER_ROUNDS; round++) {
    if (options.token.isCancellationRequested) {
      return { ok: false, error: 'Cancelled.' };
    }

    let result;
    try {
      result = await options.provider.stream(
        { messages, tools, model, reasoningEffort: 'high' },
        { onText: () => undefined },
        options.signal
      );
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        return { ok: false, error: 'Cancelled.' };
      }
      return { ok: false, error: (err as Error).message };
    }

    if (result.usage) {
      options.onUsage?.(result.usage);
    }

    const assistant: ChatMessage = {
      role: 'assistant',
      content: result.content || null
    };
    if (result.toolCalls.length > 0) {
      assistant.tool_calls = result.toolCalls;
    }
    messages.push(assistant);

    if (result.toolCalls.length === 0) {
      if (round === MAX_VERIFIER_ROUNDS - 1) {
        return {
          ok: false,
          error: 'The verifier stopped without reporting a verdict.'
        };
      }
      messages.push({
        role: 'user',
        content:
          'You have not submitted a verdict. Call submit_verification now with what you observed.'
      });
      continue;
    }

    const submission = result.toolCalls.find(
      (c) => c.function.name === SUBMIT_VERIFICATION_TOOL.function.name
    );

    for (const call of result.toolCalls) {
      if (call === submission) {
        continue;
      }
      options.bus.emit({
        type: 'tool.started',
        taskId: options.taskId,
        agentId: options.agentId,
        data: { name: call.function.name, phase: 'verification' }
      });
      const output = await runTool(call.function.name, call.function.arguments, {
        ...options.toolContext,
        owner: options.agentId
      });
      options.bus.emit({
        type: 'tool.completed',
        taskId: options.taskId,
        agentId: options.agentId,
        data: { name: call.function.name, preview: output.slice(0, 200) }
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }

    if (submission) {
      const parsed = parseVerification(submission.function.arguments, {
        attempt: options.attempt,
        conflictsDetected: options.conflictsDetected
      });

      if (!parsed.ok) {
        messages.push({
          role: 'tool',
          tool_call_id: submission.id,
          content: `Error: ${parsed.error} Call submit_verification again with valid arguments.`
        });
        continue;
      }

      // The verifier reports observations; the gate is computed from them, and
      // the baseline's findings are merged in whether or not it noticed them.
      const merged: VerificationResult = {
        ...parsed.result,
        unexpectedChanges: [
          ...new Set([...parsed.result.unexpectedChanges, ...options.unexpectedChanges])
        ].sort()
      };
      merged.passed = merged.passed && merged.unexpectedChanges.length === 0;

      options.bus.emit({
        type: merged.passed ? 'verification.completed' : 'verification.failed',
        taskId: options.taskId,
        agentId: options.agentId,
        data: {
          attempt: options.attempt,
          passed: merged.passed,
          tests: merged.tests.outcome,
          typecheck: merged.typecheck.outcome,
          lint: merged.lint.outcome,
          build: merged.build.outcome,
          issues: merged.issues.length,
          fixes: merged.requiredFixes.length
        }
      });

      return { ok: true, result: merged };
    }
  }

  return {
    ok: false,
    error: `The verifier did not report within ${MAX_VERIFIER_ROUNDS} rounds.`
  };
}

/** A verifier that could not run is a failed verification, never a pass. */
export function verificationFailure(
  reason: string,
  attempt: number
): VerificationResult {
  return unverified(`Verification could not be completed: ${reason}`, attempt);
}
