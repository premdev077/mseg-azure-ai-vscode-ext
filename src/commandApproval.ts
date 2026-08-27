import * as vscode from 'vscode';
import { Classification } from './shell/policy';

export interface PendingCommand {
  id: string;
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
  private readonly onDidResolveEmitter =
    new vscode.EventEmitter<CommandDecision>();
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

  /** Rejects everything outstanding — used when a turn is cancelled. */
  rejectAll(): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, 'rejected');
    }
  }

  dispose(): void {
    this.rejectAll();
    this.onDidResolveEmitter.dispose();
  }
}
