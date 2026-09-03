import * as vscode from 'vscode';

export const PROPOSED_SCHEME = 'azure-ai-chat-proposed';

export interface PendingEdit {
  id: string;
  /**
   * Which agent proposed this. Cancelling one agent must not reject another
   * agent's pending edits, which is exactly what an unscoped rejectAll did.
   */
  owner: string;
  uri: vscode.Uri;
  relPath: string;
  originalText: string;
  proposedText: string;
  isNewFile: boolean;
  resolve: (decision: 'accepted' | 'rejected') => void;
}

/**
 * Holds proposed file contents behind a virtual document scheme so VS Code's
 * native diff editor can render "current vs proposed", and tracks the
 * accept/reject decision the user makes in the chat panel.
 */
export class EditReviewManager implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  /** Fires whenever an edit stops being pending, so the panel can update its card. */
  private readonly onDidResolveEmitter = new vscode.EventEmitter<{
    id: string;
    decision: 'accepted' | 'rejected';
  }>();
  readonly onDidResolve = this.onDidResolveEmitter.event;

  private readonly pending = new Map<string, PendingEdit>();
  private counter = 0;

  provideTextDocumentContent(uri: vscode.Uri): string {
    const id = decodeURIComponent(uri.query.replace(/^id=/, ''));
    return this.pending.get(id)?.proposedText ?? '';
  }

  nextId(): string {
    this.counter += 1;
    return `edit-${Date.now()}-${this.counter}`;
  }

  register(edit: PendingEdit): void {
    this.pending.set(edit.id, edit);
    this.onDidChangeEmitter.fire(this.proposedUri(edit));
  }

  get(id: string): PendingEdit | undefined {
    return this.pending.get(id);
  }

  proposedUri(edit: PendingEdit): vscode.Uri {
    // Built from components, not parsed from a string: a relPath containing
    // '#' or '?' would otherwise be reparsed as a fragment/query and the
    // lookup id would be lost, rendering an empty "proposed" pane.
    return vscode.Uri.from({
      scheme: PROPOSED_SCHEME,
      path: edit.relPath,
      query: `id=${encodeURIComponent(edit.id)}`
    });
  }

  async showDiff(edit: PendingEdit): Promise<void> {
    const left = edit.isNewFile
      ? vscode.Uri.from({
          scheme: PROPOSED_SCHEME,
          path: 'empty',
          query: 'id=__empty__'
        })
      : edit.uri;
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      this.proposedUri(edit),
      `${edit.relPath} — proposed by Azure AI Chat`,
      { preview: true, preserveFocus: true }
    );
  }

  /**
   * Writes the proposed content to disk and resolves the waiting tool call.
   * Returns false when the edit is no longer pending (already resolved, or the
   * turn was cancelled), so the caller does not report a write that never happened.
   */
  async accept(id: string): Promise<boolean> {
    const edit = this.pending.get(id);
    if (!edit) {
      return false;
    }
    try {
      if (edit.isNewFile) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(edit.uri, '..'));
      }
      await vscode.workspace.fs.writeFile(
        edit.uri,
        new TextEncoder().encode(edit.proposedText)
      );
    } catch (err) {
      // Never leave the agent loop awaiting a promise that will not settle.
      this.settle(id, 'rejected');
      throw err;
    }
    this.settle(id, 'accepted');
    return true;
  }

  reject(id: string): boolean {
    return this.settle(id, 'rejected');
  }

  private settle(id: string, decision: 'accepted' | 'rejected'): boolean {
    const edit = this.pending.get(id);
    if (!edit) {
      return false;
    }
    this.pending.delete(id);
    edit.resolve(decision);
    this.onDidResolveEmitter.fire({ id, decision });
    return true;
  }

  /**
   * Rejects pending edits. With an owner, only that agent's — which is what a
   * cancelled or finished agent must do while others are still working.
   * Without one, everything, for extension shutdown.
   */
  rejectAll(owner?: string): void {
    for (const [id, edit] of [...this.pending.entries()]) {
      if (owner === undefined || edit.owner === owner) {
        this.settle(id, 'rejected');
      }
    }
  }

  /** Ids still awaiting a decision, optionally for one agent. */
  pendingIds(owner?: string): string[] {
    return [...this.pending.values()]
      .filter((e) => owner === undefined || e.owner === owner)
      .map((e) => e.id);
  }

  dispose(): void {
    this.rejectAll();
    this.onDidChangeEmitter.dispose();
    this.onDidResolveEmitter.dispose();
  }
}

export interface DiffStat {
  added: number;
  removed: number;
}

/** Cheap line-level diff stat, good enough for an "+12 −3" badge. */
export function diffStat(before: string, after: string): DiffStat {
  const a = before ? before.split(/\r?\n/) : [];
  const b = after ? after.split(/\r?\n/) : [];
  const counts = new Map<string, number>();
  for (const line of a) {
    counts.set(line, (counts.get(line) ?? 0) - 1);
  }
  for (const line of b) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let added = 0;
  let removed = 0;
  for (const n of counts.values()) {
    if (n > 0) {
      added += n;
    } else if (n < 0) {
      removed += -n;
    }
  }
  return { added, removed };
}
