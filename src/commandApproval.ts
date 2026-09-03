import * as vscode from 'vscode';
import { Classification } from './shell/policy';

export interface PendingCommand {
  id: string;
  /** Which agent asked. Scopes rejectAll so agents cannot cancel each other. */
  owner: string;
  command: string;
  cwd: string;
  classification: Classification;
  resolve: (decision: 'approved' | 'rejected') => void;
}

export interface CommandDecision {
  id: string;
  decision: 'approved' | 'rejected';
}

/**
 * Holds commands that need a click before they run, mirroring how proposed
 * file edits are gated. Kept separate from the edit manager because the two
 * have different payloads and the edit path is already load-bearing.
 */
export class CommandApprovalManager {
  private readonly onDidResolveEmitter = new vscode.EventEmitter<CommandDecision>();
  readonly onDidResolve = this.onDidResolveEmitter.event;

  private readonly pending = new Map<string, PendingCommand>();
  private counter = 0;

  nextId(): string {
    this.counter += 1;
    return `cmd-${Date.now()}-${this.counter}`;
  }

  register(entry: PendingCommand): void {
    this.pending.set(entry.id, entry);
  }

  get(id: string): PendingCommand | undefined {
    return this.pending.get(id);
  }

  approve(id: string): boolean {
    return this.settle(id, 'approved');
  }

  reject(id: string): boolean {
    return this.settle(id, 'rejected');
  }

  private settle(id: string, decision: 'approved' | 'rejected'): boolean {
    const entry = this.pending.get(id);
    if (!entry) {
      return false;
    }
    this.pending.delete(id);
    entry.resolve(decision);
    this.onDidResolveEmitter.fire({ id, decision });
    return true;
  }

  /**
   * Rejects outstanding commands. With an owner, only that agent's; without
   * one, everything. Mirrors EditReviewManager so both gates behave the same
   * way when an agent is cancelled mid-run.
   */
  rejectAll(owner?: string): void {
    for (const [id, entry] of [...this.pending.entries()]) {
      if (owner === undefined || entry.owner === owner) {
        this.settle(id, 'rejected');
      }
    }
  }

  /** Ids still awaiting a decision, optionally for one agent. */
  pendingIds(owner?: string): string[] {
    return [...this.pending.values()]
      .filter((c) => owner === undefined || c.owner === owner)
      .map((c) => c.id);
  }

  dispose(): void {
    this.rejectAll();
    this.onDidResolveEmitter.dispose();
  }
}
