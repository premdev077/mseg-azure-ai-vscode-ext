import * as vscode from 'vscode';
import { AIModelProvider } from '../../ai/provider';
import { Settings } from '../../config';
import { EventBus } from '../../events/bus';
import { ToolContext } from '../../tools';
import { Budget } from '../budget';
import { ConcurrencyLimits } from '../scheduler';
import { runGraph } from '../scheduler';
import { TaskGraph } from '../taskGraph';
import { aggregatePlans, PlanFailure, shouldProceed } from './aggregate';
import { PLANNERS } from './planners';
import { runPlanner } from './runner';
import { AgentPlan, AggregatedPlan, PlannerSpec } from './types';

export interface PlanningPhaseOptions {
  request: string;
  basePrompt: string;
  taskId: string;
  settings: Settings;
  provider: AIModelProvider;
  bus: EventBus;
  budget: Budget;
  concurrency: ConcurrencyLimits;
  toolContext: Omit<ToolContext, 'owner'>;
  signal: AbortSignal;
  token: vscode.CancellationToken;
  /** Defaults to every planner. Narrowed for a small task, or in tests. */
  planners?: readonly PlannerSpec[];
}

export interface PlanningPhaseResult {
  aggregate: AggregatedPlan;
  /** Whether there is enough here to implement from, and why. */
  proceed: boolean;
  reason: string;
  /** Critical planners that failed, which is what blocks a run outright. */
  criticalFailures: string[];
}

/**
 * Runs every planning sweep concurrently and merges the results.
 *
 * Concurrency comes from the shared scheduler rather than a bare
 * `Promise.all`, so planners are subject to the same limits and budget as
 * every other agent — five model calls fired at one Azure deployment with no
 * ceiling is how a run gets rate-limited into failure.
 *
 * The planners have no dependencies on each other by design: they read the
 * same repository from different angles, and the value of running them apart
 * is that their agreement means something afterwards.
 */
export async function runPlanningPhase(
  options: PlanningPhaseOptions
): Promise<PlanningPhaseResult> {
  const planners = options.planners ?? PLANNERS;
  const graph = new TaskGraph();

  for (const planner of planners) {
    graph.add({
      id: `plan-${planner.id}`,
      objective: planner.label,
      role: 'planner',
      // The critical sweep goes first when the pool is smaller than the
      // planner count, so a budget cut-off loses an optional angle rather
      // than the one the run cannot proceed without.
      priority: planner.critical ? 'high' : 'normal'
    });
  }

  const plans: AgentPlan[] = [];
  const failures: PlanFailure[] = [];
  const byNode = new Map(planners.map((p) => [`plan-${p.id}`, p]));

  options.bus.emit({
    type: 'planning.started',
    taskId: options.taskId,
    data: { planners: planners.map((p) => p.id), count: planners.length }
  });

  await runGraph(
    graph,
    options.budget,
    options.concurrency,
    {
      run: async (node) => {
        const planner = byNode.get(node.id);
        if (!planner) {
          return { ok: false, error: `Unknown planner node "${node.id}".` };
        }

        const result = await runPlanner({
          planner,
          request: options.request,
          basePrompt: options.basePrompt,
          agentId: node.id,
          taskId: options.taskId,
          settings: options.settings,
          provider: options.provider,
          bus: options.bus,
          toolContext: options.toolContext,
          signal: options.signal,
          token: options.token,
          onUsage: (usage) => options.budget.charge(usage)
        });

        if (result.ok) {
          plans.push(result.plan);
          return { ok: true };
        }

        failures.push({ planner: planner.id, reason: result.error });
        // A failed sweep is recorded as a failed node so the run reports it,
        // but the planners are independent so nothing is skipped because of it.
        return { ok: false, error: result.error };
      }
    },
    { isCancellationRequested: options.token.isCancellationRequested }
  );

  // Stable order regardless of which planner finished first, so the same
  // inputs produce the same aggregate.
  const order = new Map(planners.map((p, i) => [p.id, i]));
  plans.sort((a, b) => (order.get(a.planner) ?? 0) - (order.get(b.planner) ?? 0));
  failures.sort((a, b) => (order.get(a.planner) ?? 0) - (order.get(b.planner) ?? 0));

  const aggregate = aggregatePlans(plans, failures);
  const criticalFailures = failures
    .filter((f) => planners.find((p) => p.id === f.planner)?.critical)
    .map((f) => f.planner);

  const decision = shouldProceed(aggregate, { criticalFailures });

  options.bus.emit({
    type: 'planning.completed',
    taskId: options.taskId,
    data: {
      plans: plans.length,
      failed: failures.length,
      files: aggregate.relevantFiles.length,
      changes: aggregate.changes.length,
      conflicts: aggregate.conflicts.length,
      confidence: Number(aggregate.confidence.toFixed(2)),
      proceed: decision.proceed
    }
  });

  return {
    aggregate,
    proceed: decision.proceed,
    reason: decision.reason,
    criticalFailures
  };
}

/**
 * Renders the aggregate as the brief it hands to implementation.
 *
 * Deliberately terse: an implementation agent needs the decisions, not five
 * analyses. Conflicts are stated as open questions rather than resolved
 * silently, so the coder knows where the planners were unsure.
 */
export function renderPlanBrief(aggregate: AggregatedPlan): string {
  const lines: string[] = ['# Plan', '', aggregate.summary, ''];

  if (aggregate.relevantFiles.length) {
    lines.push('## Relevant files', '');
    for (const file of aggregate.relevantFiles.slice(0, 25)) {
      lines.push(`- ${file}`);
    }
    lines.push('');
  }

  if (aggregate.changes.length) {
    lines.push('## Changes to make', '');
    for (const change of aggregate.changes) {
      lines.push(`- **${change.kind}** \`${change.filePath}\` — ${change.rationale}`);
    }
    lines.push('');
  }

  if (aggregate.conflicts.length) {
    lines.push(
      '## Unresolved disagreements',
      '',
      'The planners did not agree on these. Read the file before acting, and say which you chose.',
      ''
    );
    for (const conflict of aggregate.conflicts) {
      lines.push(`- \`${conflict.filePath}\`:`);
      for (const position of conflict.positions) {
        lines.push(
          `  - ${position.planner} wants to **${position.kind}** it: ${position.rationale}`
        );
      }
    }
    lines.push('');
  }

  if (aggregate.risks.length) {
    lines.push('## Risks', '');
    for (const risk of aggregate.risks) {
      lines.push(`- **${risk.severity}** — ${risk.description}`);
    }
    lines.push('');
  }

  const testing = aggregate.testingStrategy;
  if (
    testing.existingTests.length ||
    testing.newTests.length ||
    testing.commands.length
  ) {
    lines.push('## Verification', '');
    if (testing.existingTests.length) {
      lines.push(`- Existing tests: ${testing.existingTests.join(', ')}`);
    }
    if (testing.newTests.length) {
      lines.push(`- Tests to add or update: ${testing.newTests.join(', ')}`);
    }
    if (testing.commands.length) {
      lines.push(`- Commands: ${testing.commands.join(', ')}`);
    }
    lines.push('');
  }

  if (aggregate.failures.length) {
    lines.push(
      '## Incomplete analysis',
      '',
      `These sweeps did not report, so the plan is partial: ${aggregate.failures
        .map((f) => `${f.planner} (${f.reason})`)
        .join('; ')}.`,
      ''
    );
  }

  return lines.join('\n').trimEnd();
}
