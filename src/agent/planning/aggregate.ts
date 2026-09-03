import {
  AgentPlan,
  AggregatedPlan,
  ChangeKind,
  PlanConflict,
  ProposedChange,
  Risk,
  RiskSeverity,
  TestingStrategy
} from './types';

export interface PlanFailure {
  planner: string;
  reason: string;
}

/**
 * Merges what the planners found into one plan the Coordinator can act on.
 *
 * The rule that matters: do not implement the first plan that came back. Five
 * agents looking at the same repository from different angles will overlap,
 * and where they disagree about a file that disagreement is a signal, not
 * noise — so it is surfaced rather than silently resolved by whoever answered
 * first.
 */

/** Deleting is the most consequential, creating the least. */
const KIND_WEIGHT: Record<ChangeKind, number> = { delete: 2, create: 1, modify: 0 };
const SEVERITY_WEIGHT: Record<RiskSeverity, number> = { high: 2, medium: 1, low: 0 };

function normalisePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Files every plan mentioned, most-cited first.
 *
 * Citation count is a decent relevance signal precisely because the planners
 * worked independently: a file three of them found on their own is more likely
 * to matter than one that only the security sweep noticed.
 */
export function rankRelevantFiles(plans: AgentPlan[]): string[] {
  const votes = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;

  for (const plan of plans) {
    const cited = new Set<string>();
    for (const file of [
      ...plan.relevantFiles,
      ...plan.proposedChanges.map((c) => c.filePath)
    ]) {
      const key = normalisePath(file);
      if (!key || cited.has(key)) {
        continue;
      }
      cited.add(key);
      votes.set(key, (votes.get(key) ?? 0) + 1);
      if (!firstSeen.has(key)) {
        firstSeen.set(key, order++);
      }
    }
  }

  return [...votes.entries()]
    .sort(
      (a, b) => b[1] - a[1] || (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0)
    )
    .map(([file]) => file);
}

/**
 * Reconciles per-file changes.
 *
 * Two planners proposing the same file is agreement, not conflict. Two
 * planners proposing *different operations* on one file is a real conflict —
 * "modify auth.ts" and "delete auth.ts" cannot both be right, and guessing
 * would be how the wrong one wins.
 */
export function reconcileChanges(plans: AgentPlan[]): {
  changes: ProposedChange[];
  conflicts: PlanConflict[];
} {
  const byFile = new Map<
    string,
    Array<{ planner: string; change: ProposedChange; confidence: number }>
  >();

  for (const plan of plans) {
    for (const change of plan.proposedChanges) {
      const key = normalisePath(change.filePath);
      const list = byFile.get(key) ?? [];
      list.push({ planner: plan.planner, change, confidence: plan.confidence });
      byFile.set(key, list);
    }
  }

  const changes: ProposedChange[] = [];
  const conflicts: PlanConflict[] = [];

  for (const [filePath, entries] of byFile) {
    const kinds = new Set(entries.map((e) => e.change.kind));

    if (kinds.size > 1) {
      conflicts.push({
        filePath,
        positions: entries.map((e) => ({
          planner: e.planner,
          kind: e.change.kind,
          rationale: e.change.rationale
        })),
        description: `${entries.length} planners disagree about ${filePath}: ${[
          ...kinds
        ].join(' vs ')}.`
      });
    }

    // Take the most consequential operation, breaking ties on the confidence
    // of the plan that proposed it. A conflicted file still gets a change so
    // the run can proceed — the conflict is reported alongside it, not instead.
    const winner = [...entries].sort(
      (a, b) =>
        KIND_WEIGHT[b.change.kind] - KIND_WEIGHT[a.change.kind] ||
        b.confidence - a.confidence
    )[0];

    const rationales = [...new Set(entries.map((e) => e.change.rationale))];
    changes.push({
      filePath,
      kind: winner.change.kind,
      rationale:
        rationales.length === 1
          ? rationales[0]
          : rationales
              .map((r, i) => `(${entries[i]?.planner ?? 'plan'}) ${r}`)
              .join(' ')
    });
  }

  changes.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return { changes, conflicts };
}

/** Highest severity first, de-duplicated on description. */
export function mergeRisks(plans: AgentPlan[]): Risk[] {
  const seen = new Map<string, Risk>();
  for (const plan of plans) {
    for (const risk of plan.risks) {
      const key = risk.description.toLowerCase().trim();
      const existing = seen.get(key);
      if (
        !existing ||
        SEVERITY_WEIGHT[risk.severity] > SEVERITY_WEIGHT[existing.severity]
      ) {
        seen.set(key, {
          ...risk,
          files: [...new Set([...(existing?.files ?? []), ...risk.files])]
        });
      } else {
        existing.files = [...new Set([...existing.files, ...risk.files])];
      }
    }
  }
  return [...seen.values()].sort(
    (a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]
  );
}

export function mergeTesting(plans: AgentPlan[]): TestingStrategy {
  const union = (pick: (s: TestingStrategy) => string[]): string[] => [
    ...new Set(plans.flatMap((p) => pick(p.testingStrategy)))
  ];
  return {
    existingTests: union((s) => s.existingTests),
    newTests: union((s) => s.newTests),
    commands: union((s) => s.commands)
  };
}

/**
 * Combines every planner's output.
 *
 * Failures are carried through rather than dropped: a plan built from three of
 * five sweeps is still usable, but the Coordinator has to know which two are
 * missing before it decides whether to continue.
 */
export function aggregatePlans(
  plans: AgentPlan[],
  failures: PlanFailure[] = []
): AggregatedPlan {
  const { changes, conflicts } = reconcileChanges(plans);
  const confidence =
    plans.length === 0
      ? 0
      : plans.reduce((sum, p) => sum + p.confidence, 0) / plans.length;

  return {
    plans,
    failures,
    relevantFiles: rankRelevantFiles(plans),
    changes,
    conflicts,
    risks: mergeRisks(plans),
    testingStrategy: mergeTesting(plans),
    confidence,
    summary: describe(plans, failures, changes, conflicts)
  };
}

function describe(
  plans: AgentPlan[],
  failures: PlanFailure[],
  changes: ProposedChange[],
  conflicts: PlanConflict[]
): string {
  if (plans.length === 0) {
    return failures.length
      ? `No usable plan: every planner failed (${failures
          .map((f) => f.planner)
          .join(', ')}).`
      : 'No usable plan: no planners ran.';
  }

  const parts = [
    `${plans.length} planner${plans.length === 1 ? '' : 's'} reported`,
    `${changes.length} file${changes.length === 1 ? '' : 's'} to change`
  ];
  if (conflicts.length) {
    parts.push(
      `${conflicts.length} disagreement${conflicts.length === 1 ? '' : 's'} to resolve`
    );
  }
  if (failures.length) {
    parts.push(
      `${failures.length} planner(s) failed: ${failures.map((f) => f.planner).join(', ')}`
    );
  }
  return `${parts.join('; ')}.`;
}

export interface ContinueDecision {
  proceed: boolean;
  reason: string;
}

/**
 * Whether there is enough to implement from.
 *
 * One planner failing should not sink a run — that is the brief's partial
 * failure rule — but implementing from nothing, or from plans that all say
 * they are guessing, is worse than stopping and saying so.
 */
export function shouldProceed(
  aggregate: AggregatedPlan,
  options: { criticalFailures?: string[]; minConfidence?: number } = {}
): ContinueDecision {
  const critical = options.criticalFailures ?? [];
  const minConfidence = options.minConfidence ?? 0.3;

  if (critical.length > 0) {
    return {
      proceed: false,
      reason: `Planning could not continue: ${critical.join(', ')} failed, and that analysis is required for this task.`
    };
  }
  if (aggregate.plans.length === 0) {
    return { proceed: false, reason: aggregate.summary };
  }
  if (aggregate.changes.length === 0) {
    return {
      proceed: false,
      reason:
        'The planners did not identify any file that needs to change. Nothing was implemented — say what was inspected and ask what was expected to change.'
    };
  }
  if (aggregate.confidence < minConfidence) {
    return {
      proceed: false,
      reason: `The planners reported low confidence (${aggregate.confidence.toFixed(
        2
      )}). Implementing from this would be guesswork; report what was found instead.`
    };
  }
  return { proceed: true, reason: aggregate.summary };
}
