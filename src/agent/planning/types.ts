import { AgentRole } from '../roles';

/**
 * What a planning agent returns.
 *
 * Structured rather than prose, because the Coordinator has to *compare* plans
 * — find where two agents disagree about which file to change, union their
 * relevant files, and turn the result into a task graph. None of that is
 * possible against paragraphs.
 */

export type FindingType = 'fact' | 'dependency' | 'risk' | 'recommendation';

export interface Finding {
  type: FindingType;
  content: string;
  files: string[];
  /** 0–1. Used to weight a finding when plans disagree. */
  confidence: number;
}

export type ChangeKind = 'create' | 'modify' | 'delete';

export interface ProposedChange {
  filePath: string;
  kind: ChangeKind;
  /** What should change and why, in a sentence or two. */
  rationale: string;
}

export type RiskSeverity = 'low' | 'medium' | 'high';

export interface Risk {
  severity: RiskSeverity;
  description: string;
  files: string[];
}

export interface TestingStrategy {
  /** Existing tests that cover the affected code. */
  existingTests: string[];
  /** Tests that should be added or updated. */
  newTests: string[];
  /** Commands that would verify the change, if the planner found any. */
  commands: string[];
}

export interface AgentPlan {
  agentId: string;
  role: AgentRole;
  /** Which planner produced this, e.g. `architecture`. */
  planner: string;
  objective: string;
  summary: string;
  findings: Finding[];
  relevantFiles: string[];
  relevantSymbols: string[];
  dependencies: string[];
  proposedChanges: ProposedChange[];
  risks: Risk[];
  testingStrategy: TestingStrategy;
  /** 0–1, the planner's own confidence in its analysis. */
  confidence: number;
}

/** One planning agent's definition. */
export interface PlannerSpec {
  /** Stable id, used for task ids and in the UI. */
  id: string;
  /** Shown to the user, e.g. "Architecture Agent". */
  label: string;
  /** What this planner is for, appended to the system prompt. */
  focus: string;
  /**
   * Whether the run should be abandoned if this planner fails. Most analysis
   * is worth having but not essential; losing the repository sweep is.
   */
  critical: boolean;
}

/** Why the Coordinator could not simply take every plan at face value. */
export interface PlanConflict {
  filePath: string;
  /** Planner ids that disagree, with what each proposed. */
  positions: Array<{ planner: string; kind: ChangeKind; rationale: string }>;
  description: string;
}

export interface AggregatedPlan {
  /** Plans that were usable. */
  plans: AgentPlan[];
  /** Planners that failed, and why. Reported, never hidden. */
  failures: Array<{ planner: string; reason: string }>;
  /** Union of every plan's relevant files, most-cited first. */
  relevantFiles: string[];
  /** Changes to make, one per file, after conflicts are resolved. */
  changes: ProposedChange[];
  conflicts: PlanConflict[];
  risks: Risk[];
  testingStrategy: TestingStrategy;
  /** Mean confidence across contributing plans, 0 when there are none. */
  confidence: number;
  summary: string;
}
