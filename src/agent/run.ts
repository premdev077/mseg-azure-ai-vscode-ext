import * as vscode from 'vscode';
import { AIModelProvider } from '../ai/provider';
import { Settings } from '../config';
import { EventBus } from '../events/bus';
import { attributeChanges, GitBaseline } from '../git/baseline';
import { captureBaseline, currentStatus } from '../git/capture';
import { ToolContext } from '../tools';
import { ChangeLog } from './changes';
import { Coordinator } from './coordinator';
import { runCoder } from './implement/coder';
import { buildImplementationTasks } from './implement/tasks';
import { renderPlanBrief, runPlanningPhase } from './planning/phase';
import { AggregatedPlan } from './planning/types';
import { ConcurrencyLimits, DEFAULT_CONCURRENCY } from './scheduler';
import { TaskState } from './taskGraph';
import {
  DEFAULT_MAX_VERIFICATION_ATTEMPTS,
  planRepairs,
  renderFailureReport
} from './verify/repair';
import { runVerifier, verificationFailure } from './verify/verifier';
import { describeVerification, VerificationResult } from './verify/types';

export interface MultiAgentRunOptions {
  request: string;
  taskId: string;
  workspaceRoot: string;
  settings: Settings;
  provider: AIModelProvider;
  bus: EventBus;
  toolContext: Omit<
    ToolContext,
    'owner' | 'scope' | 'locks' | 'changes' | 'baseline' | 'taskId'
  >;
  signal: AbortSignal;
  token: vscode.CancellationToken;
  concurrency?: Partial<ConcurrencyLimits>;
  maxVerificationAttempts?: number;
  /** Progress text for the panel, phase by phase. */
  onProgress?: (message: string) => void;
}

export interface MultiAgentRunResult {
  state: TaskState;
  /** The user-facing report. Honest about what was and was not verified. */
  report: string;
  plan?: AggregatedPlan;
  verification?: VerificationResult;
  changedFiles: string[];
  attempts: number;
  budget: string;
}

/**
 * One complete multi-agent run: plan, implement, verify, repair, verify again.
 *
 * The sequence is fixed and the gate is at the end. Nothing here can reach
 * `completed` except a passing verification, and each phase can stop the run
 * early with an honest reason — a planning phase with nothing to go on does
 * not proceed to implementation just because it was asked to.
 */
export async function runMultiAgentTask(
  options: MultiAgentRunOptions
): Promise<MultiAgentRunResult> {
  const concurrency: ConcurrencyLimits = {
    ...DEFAULT_CONCURRENCY,
    ...options.concurrency
  };
  const maxAttempts =
    options.maxVerificationAttempts ?? DEFAULT_MAX_VERIFICATION_ATTEMPTS;

  const coordinator = new Coordinator({
    bus: options.bus,
    taskId: options.taskId,
    budget: options.settings.budget,
    concurrency
  });
  const budget = coordinator.budget;
  const changes = new ChangeLog();

  const finish = (
    state: TaskState,
    report: string,
    extra: Partial<MultiAgentRunResult> = {}
  ): MultiAgentRunResult => ({
    state,
    report,
    changedFiles: changes.changedFiles(),
    attempts: 0,
    budget: budget.describe(),
    ...extra
  });

  // --- baseline ------------------------------------------------------------
  // Taken before anything runs. Without it there is no way to tell the run's
  // edits from work the user already had in progress.
  const baseline: GitBaseline = await captureBaseline(
    options.workspaceRoot,
    options.settings,
    options.token
  );
  if (baseline.dirtyFiles.length > 0) {
    options.onProgress?.(
      `${baseline.dirtyFiles.length} file(s) already had uncommitted changes; they will be protected.`
    );
  }

  // --- planning ------------------------------------------------------------
  options.onProgress?.('Planning: running analysis agents in parallel…');

  const planning = await runPlanningPhase({
    request: options.request,
    basePrompt: `The user asked: "${options.request}"`,
    taskId: options.taskId,
    settings: options.settings,
    provider: options.provider,
    bus: options.bus,
    budget,
    concurrency,
    toolContext: options.toolContext,
    signal: options.signal,
    token: options.token
  });

  if (options.token.isCancellationRequested) {
    return finish('cancelled', 'The run was cancelled during planning.', {
      plan: planning.aggregate
    });
  }

  if (!planning.proceed) {
    return finish(
      'failed',
      [
        'The work was not started.',
        '',
        planning.reason,
        '',
        planning.aggregate.summary
      ].join('\n'),
      { plan: planning.aggregate }
    );
  }

  const planBrief = renderPlanBrief(planning.aggregate);

  // --- implementation ------------------------------------------------------
  const tasks = buildImplementationTasks(planning.aggregate, {
    maxCoders: concurrency.maxCodingAgents
  });

  options.onProgress?.(
    `Implementing: ${tasks.length} scoped agent(s) across ${planning.aggregate.changes.length} file(s).`
  );

  for (const task of tasks) {
    coordinator.addTask(task);
  }

  const cancelSignal = {
    get isCancellationRequested() {
      return options.token.isCancellationRequested;
    }
  };

  const implementation = await coordinator.run(async (ctx) => {
    const result = await runCoder({
      objective: ctx.node.objective,
      planBrief,
      request: options.request,
      scope: { allowedFiles: ctx.node.allowedFiles },
      role: 'coder',
      agentId: ctx.agentId,
      taskId: options.taskId,
      settings: options.settings,
      provider: options.provider,
      bus: options.bus,
      locks: ctx.locks,
      changes,
      baseline,
      toolContext: options.toolContext,
      signal: options.signal,
      token: options.token,
      onUsage: (usage) => budget.charge(usage)
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }, cancelSignal);

  if (options.token.isCancellationRequested) {
    return finish(
      'cancelled',
      [
        'The run was cancelled during implementation.',
        '',
        changes.describe(),
        'Changes already accepted are still on disk and were not rolled back.'
      ].join('\n'),
      { plan: planning.aggregate }
    );
  }

  // A failed coder does not skip verification. Whatever did land still needs
  // checking, and the verifier's report is more useful than the coder's error.
  if (implementation.failed > 0) {
    options.onProgress?.(
      `${implementation.failed} implementation agent(s) failed; verifying what did land.`
    );
  }

  // --- verify, repair, verify ---------------------------------------------
  let verification: VerificationResult | undefined;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    options.onProgress?.(
      attempt === 1
        ? 'Verifying: independent agent checking the work…'
        : `Verifying again (attempt ${attempt} of ${maxAttempts})…`
    );

    const finalStatus = await currentStatus(
      options.workspaceRoot,
      options.settings,
      options.token
    );
    const attribution = attributeChanges(baseline, finalStatus, changes.changedFiles());

    const outcome = await runVerifier({
      request: options.request,
      planBrief,
      changes,
      unexpectedChanges: attribution.unexpected,
      conflictsDetected: attribution.touchedPreexisting.length > 0,
      attempt,
      taskId: options.taskId,
      agentId: `verifier-${attempt}`,
      settings: options.settings,
      provider: options.provider,
      bus: options.bus,
      toolContext: options.toolContext,
      signal: options.signal,
      token: options.token,
      onUsage: (usage) => budget.charge(usage)
    });

    verification = outcome.ok
      ? outcome.result
      : verificationFailure(outcome.error, attempt);

    if (verification.passed) {
      return finish(
        'completed',
        [
          'Task completed and verified.',
          '',
          verification.summary,
          '',
          describeVerification(verification),
          '',
          changes.describe(),
          ...changes.changedFiles().map((f) => `  ${f}`),
          '',
          `Budget: ${budget.describe()}`
        ].join('\n'),
        { plan: planning.aggregate, verification, attempts: attempt }
      );
    }

    if (options.token.isCancellationRequested) {
      break;
    }

    const repairs = planRepairs(verification, {
      attempt,
      maxAttempts,
      maxRepairAgents: concurrency.maxRepairAgents
    });

    if (!repairs.shouldRetry) {
      options.onProgress?.(repairs.reason);
      break;
    }

    options.onProgress?.(repairs.reason);
    options.bus.emit({
      type: 'repair.started',
      taskId: options.taskId,
      data: { attempt, tasks: repairs.tasks.length }
    });

    // Each repair round is its own graph, so a repair failing does not skip
    // the verification that has to follow it.
    const repairCoordinator = new Coordinator({
      bus: options.bus,
      taskId: options.taskId,
      budget: options.settings.budget,
      concurrency
    });
    for (const task of repairs.tasks) {
      repairCoordinator.addTask(task);
    }

    await repairCoordinator.run(async (ctx) => {
      const result = await runCoder({
        objective: ctx.node.objective,
        planBrief,
        request: options.request,
        scope: { allowedFiles: ctx.node.allowedFiles },
        role: 'repair',
        agentId: ctx.agentId,
        taskId: options.taskId,
        settings: options.settings,
        provider: options.provider,
        bus: options.bus,
        locks: ctx.locks,
        changes,
        baseline,
        toolContext: options.toolContext,
        signal: options.signal,
        token: options.token,
        onUsage: (usage) => budget.charge(usage)
      });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }, cancelSignal);

    options.bus.emit({
      type: 'repair.completed',
      taskId: options.taskId,
      data: { attempt, tasks: repairs.tasks.length }
    });
  }

  const result = verification ?? verificationFailure('It did not run.', attempt);

  if (options.token.isCancellationRequested) {
    return finish('cancelled', 'The run was cancelled during verification.', {
      plan: planning.aggregate,
      verification: result,
      attempts: attempt
    });
  }

  return finish(
    'failed',
    [
      renderFailureReport(result, changes.changedFiles(), attempt, maxAttempts),
      '',
      `Budget: ${budget.describe()}`
    ].join('\n'),
    { plan: planning.aggregate, verification: result, attempts: attempt }
  );
}
