import type { AgentId, CheckOutcomeName, NodeRole } from '../../../src/events/types';

/**
 * View models the UI renders.
 *
 * Deliberately separate from the event payloads: an event describes something
 * that happened, a view model describes what a panel shows. Collapsing the two
 * means every UI tweak becomes a protocol change.
 *
 * Collections are normalised — `Record<Id, Entity>` plus an ordered `Id[]` — so
 * one agent's progress updates one entry instead of replacing an array on every
 * streamed token.
 */

export type AgentStatus = 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentView {
  readonly id: AgentId;
  readonly role: NodeRole | 'agent';
  readonly label: string;
  readonly status: AgentStatus;
  /** Safe operational progress. Never private reasoning. */
  readonly activity: string;
  readonly files: readonly string[];
  readonly tools: readonly string[];
  readonly startedAt?: number | undefined;
  readonly finishedAt?: number | undefined;
  readonly error?: string | undefined;
  /** Agents it is queued behind, so the UI can explain a wait. */
  readonly waitedOn: readonly string[];
}

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolView {
  readonly id: string;
  readonly agentId?: AgentId | undefined;
  readonly name: string;
  readonly args: string;
  readonly status: ToolStatus;
  readonly preview?: string | undefined;
  readonly at: number;
}

export type ChangeStatus = 'proposed' | 'accepted' | 'rejected' | 'expired';

export interface ChangeView {
  readonly relPath: string;
  readonly added: number;
  readonly removed: number;
  readonly isNewFile: boolean;
  readonly status: ChangeStatus;
  /** The pending-edit id, so Accept and Reject can address it. */
  readonly editId?: string | undefined;
}

export type CommandStatus =
  'pending' | 'approved' | 'rejected' | 'finished' | 'expired';

export interface CommandView {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly reason: string;
  readonly autoRun: boolean;
  readonly status: CommandStatus;
  readonly exitCode?: number | null | undefined;
  readonly durationMs?: number | undefined;
  readonly output?: string | undefined;
}

export type CheckState = CheckOutcomeName | 'pending';

export interface VerificationView {
  readonly attempt: number;
  readonly status: 'running' | 'passed' | 'failed';
  readonly typecheck: CheckState;
  readonly lint: CheckState;
  readonly tests: CheckState;
  readonly build: CheckState;
  readonly issues: number;
  readonly fixes: number;
}

export interface PlanView {
  readonly planners: readonly string[];
  readonly completed: readonly string[];
  readonly failed: readonly string[];
  readonly files: number;
  readonly changes: number;
  readonly conflicts: number;
  readonly confidence: number;
  readonly status: 'running' | 'done';
}

export interface MessageView {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  /** True while deltas are still arriving. */
  readonly streaming: boolean;
  readonly at: number;
}

export interface NoticeView {
  readonly id: string;
  readonly text: string;
  readonly kind: 'info' | 'error';
}

export type TaskPhase =
  | 'idle'
  | 'planning'
  | 'implementing'
  | 'verifying'
  | 'repairing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * How the webview stands relative to the extension host.
 *
 * There is no socket to drop — both run in one VS Code process joined by
 * postMessage. What can happen is the webview being torn down and rebuilt
 * while the run continues, so `catching-up` means "replaying what we missed",
 * not "reconnecting".
 */
export type ConnectionState =
  'connecting' | 'live' | 'catching-up' | 'degraded' | 'lost';
