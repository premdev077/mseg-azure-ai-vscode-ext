import * as vscode from 'vscode';
import { ChatSession, SendOptions } from './chatSession';
import { EditReviewManager } from './editReview';
import { CommandApprovalManager } from './commandApproval';
import { SessionRecorder } from './history';
import { getSettings, Settings } from './config';
import { parseWebviewMessage } from './webviewMessages';
import {
  Attachment,
  attachmentPickerFilters,
  formatBytes,
  readAttachment
} from './attachments';
import { ReasoningEffort } from './azureClient';
import { ConversationStore, renderTranscript } from './conversations';
import { AIModelProvider } from './ai/provider';
import { isAgentMode, MODE_PROFILES } from './agent/mode';
import { describeState } from './agent/state';
import { Coordinator } from './agent/coordinator';
import { runMultiAgentTask } from './agent/run';
import { EventBus } from './events/bus';
import type { AgentEventType, EmitOptions, EventDataMap } from './events/types';

interface QueuedPrompt {
  text: string;
  autosend: boolean;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'azureAiChat.chatView';

  private view: vscode.WebviewView | undefined;
  private readonly session: ChatSession;
  private webviewReady = false;
  private queued: QueuedPrompt | undefined;

  /** Attachments staged for the next message. Held here, not in the webview,
   *  because a base64 image is far too heavy to round-trip through postMessage. */
  private readonly staged = new Map<string, Attachment>();
  private historyOpen = false;

  /**
   * Every agent-side event goes through here before it reaches the webview,
   * so each one is stamped, ordered, redacted and replayable. UI plumbing
   * (status, history, attachments) still posts directly — those are not
   * things that happened in the workspace.
   */
  private readonly bus = new EventBus();

  /** Set only while a coordinated run is in flight, so Stop can reach it. */
  private activeRun:
    | {
        coordinator?: Coordinator;
        signal: { isCancellationRequested: boolean };
        controller?: AbortController;
        cts?: vscode.CancellationTokenSource;
      }
    | undefined;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly edits: EditReviewManager,
    private readonly commands: CommandApprovalManager,
    private readonly recorder: SessionRecorder,
    private readonly store: ConversationStore,
    private readonly model: AIModelProvider
  ) {
    this.session = new ChatSession(
      this.ctx,
      this.edits,
      this.commands,
      this.recorder,
      this.store,
      this.model,
      {
        onAssistantStart: () => this.emit('model.started', {}),
        onText: (delta) => this.emit('model.text', { delta }),
        onReasoning: (delta) => this.emit('model.reasoning', { delta }),
        onToolStart: (name, args) =>
          this.emit('tool.started', { name, args: summarizeArgs(args) }),
        onToolEnd: (name, preview) => this.emit('tool.completed', { name, preview }),
        onEditProposed: (info) => this.emit('file.edit.proposed', { ...info }),
        onCommandProposed: (info) => this.emit('command.proposed', { ...info }),
        onCommandFinished: (info) => this.emit('command.finished', { ...info }),
        onDone: (info) => this.emit('model.completed', { ...info }),
        onError: (message) => this.emit('error', { message }),
        onContextAttached: (label) => this.emit('context.attached', { label }),
        onNotice: (message) => this.emit('notice', { message }),
        onState: (state) =>
          this.emit('agent.state', { state, label: describeState(state) }),
        // Only the coordinated single-agent path has a coordinator here; a
        // multi-agent run charges its own budget from inside runMultiAgentTask.
        onUsage: (usage) => this.activeRun?.coordinator?.budget.charge(usage),
        onConversationSaved: () => {
          if (this.historyOpen) {
            void this.sendHistory();
          }
        }
      }
    );

    this.ctx.subscriptions.push(
      this.edits.onDidResolve(({ id, decision }) =>
        this.emit('file.edit.resolved', { id, decision })
      ),
      this.commands.onDidResolve(({ id, decision }) =>
        this.emit('command.resolved', { id, decision })
      ),
      // The webview consumes AgentEvent directly and interprets it in one
      // reducer, so there is nothing to translate on the way out.
      this.bus.on((event) => this.post({ type: 'event', event })),
      { dispose: () => this.bus.dispose() }
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')]
    };
    view.webview.html = this.html(view.webview);

    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.webviewReady = false;
      }
      this.session.cancel();
    });

    view.webview.onDidReceiveMessage(async (raw: unknown) => {
      // The webview renders model and tool output, so what it sends back is
      // validated before it can reach the filesystem or git.
      const msg = parseWebviewMessage(raw);
      if (!msg) {
        return;
      }

      switch (msg.type) {
        case 'ready':
          this.webviewReady = true;
          this.post({ type: 'status', ...this.statusPayload() });
          this.replay(msg.lastSequence);
          if (this.queued) {
            const q = this.queued;
            this.queued = undefined;
            this.post({ type: 'prefill', text: q.text, autosend: q.autosend });
          }
          break;

        case 'send': {
          const attachments = [...this.staged.values()];
          this.staged.clear();
          this.post({
            type: 'userMessage',
            text: msg.text,
            attachments: attachments.map(toChip)
          });
          this.post({ type: 'attachmentsCleared' });
          await this.dispatch(msg.text, {
            model: msg.model,
            reasoningEffort: normaliseEffort(msg.reasoningEffort),
            attachments,
            attachEditorContext: msg.attachContext,
            mode: isAgentMode(msg.mode) ? msg.mode : undefined
          });
          break;
        }

        case 'attach':
          await this.pickAttachments();
          break;

        case 'removeAttachment':
          this.staged.delete(msg.id);
          this.post({ type: 'attachments', items: this.chips() });
          break;

        case 'cancel':
          if (this.activeRun) {
            this.activeRun.signal.isCancellationRequested = true;
            this.activeRun.controller?.abort();
            this.activeRun.cts?.cancel();
          }
          this.session.cancel();
          this.emit('task.cancelled', {});
          break;

        case 'newChat':
          this.session.reset();
          this.staged.clear();
          this.post({ type: 'cleared' });
          break;

        case 'acceptEdit':
          try {
            if (!(await this.edits.accept(msg.id))) {
              this.emit('file.edit.expired', { id: msg.id });
            }
          } catch (e) {
            this.emit('error', {
              message: `Could not write the file: ${(e as Error).message}`
            });
          }
          break;

        case 'rejectEdit':
          if (!this.edits.reject(msg.id)) {
            this.emit('file.edit.expired', { id: msg.id });
          }
          break;

        case 'approveCommand':
          if (!this.commands.approve(msg.id)) {
            this.emit('command.expired', { id: msg.id });
          }
          break;

        case 'rejectCommand':
          if (!this.commands.reject(msg.id)) {
            this.emit('command.expired', { id: msg.id });
          }
          break;

        case 'openDiff': {
          const edit = this.edits.get(msg.id);
          if (edit) {
            await this.edits.showDiff(edit);
          } else {
            this.emit('file.edit.expired', { id: msg.id });
          }
          break;
        }

        case 'openHistory':
          this.historyOpen = true;
          await this.sendHistory();
          break;

        case 'closeHistory':
          this.historyOpen = false;
          break;

        case 'loadConversation':
          await this.openConversation(msg.id);
          break;

        case 'deleteConversation':
          await this.store.delete(msg.id);
          await this.sendHistory();
          break;

        case 'showReport':
          await vscode.commands.executeCommand('azureAiChat.showReport');
          break;

        case 'openSettings':
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'azureAiChat'
          );
          break;

        case 'setApiKey':
          await vscode.commands.executeCommand('azureAiChat.setApiKey');
          this.post({ type: 'status', ...this.statusPayload() });
          break;

        case 'openFile': {
          const relPath = msg.relPath;
          {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (folder) {
              const uri = vscode.Uri.joinPath(folder.uri, relPath);
              try {
                await vscode.window.showTextDocument(uri, { preview: true });
              } catch {
                this.emit('notice', {
                  message: `Could not open ${relPath}. It may have been moved or deleted.`
                });
              }
            }
          }
          break;
        }

        case 'copy':
          await vscode.env.clipboard.writeText(msg.text);
          break;

        case 'insertAtCursor': {
          const editor = vscode.window.activeTextEditor;
          if (!editor) {
            vscode.window.showWarningMessage(
              'Azure AI Chat: open a file first, then insert.'
            );
            break;
          }
          await editor.edit((b: vscode.TextEditorEdit) =>
            b.replace(editor.selection, msg.text)
          );
          break;
        }
      }
    });
  }

  /** Opens the multi-select file picker and stages what it returns. */
  async pickAttachments(uris?: vscode.Uri[]): Promise<void> {
    const picked =
      uris ??
      (await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Attach',
        title: 'Attach files for the assistant to read',
        filters: attachmentPickerFilters()
      }));

    if (!picked || picked.length === 0) {
      return;
    }

    const settings = getSettings();
    this.post({ type: 'attachmentsLoading', count: picked.length });

    for (const uri of picked) {
      try {
        const attachment = await readAttachment(uri, settings);
        this.staged.set(attachment.id, attachment);
      } catch (e) {
        vscode.window.showWarningMessage(
          `Azure AI Chat: could not attach ${uri.fsPath} — ${(e as Error).message}`
        );
      }
    }

    this.post({ type: 'attachments', items: this.chips() });
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
  }

  private chips(): unknown[] {
    return [...this.staged.values()].map(toChip);
  }

  private async sendHistory(): Promise<void> {
    const items = await this.store.list();
    this.post({
      type: 'history',
      items,
      currentId: this.session.id,
      folder: this.store.folder.fsPath
    });
  }

  /** Reopens a stored conversation and redraws it so it can be continued. */
  async openConversation(id: string): Promise<void> {
    const conversation = await this.store.load(id);
    if (!conversation) {
      this.emit('error', {
        message: 'That conversation could not be read. It may have been deleted.'
      });
      await this.sendHistory();
      return;
    }

    this.session.loadConversation(conversation);
    this.staged.clear();
    this.historyOpen = false;
    this.post({
      type: 'restore',
      title: conversation.title,
      model: conversation.model,
      turns: renderTranscript(conversation.messages)
    });
  }

  async showHistory(): Promise<void> {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    this.historyOpen = true;
    await this.sendHistory();
  }

  newChat(): void {
    this.session.reset();
    this.staged.clear();
    this.post({ type: 'cleared' });
  }

  refreshStatus(): void {
    this.post({ type: 'status', ...this.statusPayload() });
  }

  async ask(text: string): Promise<void> {
    this.queued = { text, autosend: true };
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    this.view?.show?.(true);
    if (this.view && this.webviewReady && this.queued) {
      const q = this.queued;
      this.queued = undefined;
      this.post({ type: 'prefill', text: q.text, autosend: q.autosend });
    }
  }

  private statusPayload() {
    const s = getSettings();
    return {
      configured: Boolean(s.endpoint && s.deployment),
      endpoint: s.endpoint,
      models: s.models,
      defaultEffort: s.defaultReasoningEffort,
      defaultMode: s.defaultMode,
      orchestration: s.orchestration,
      modes: Object.values(MODE_PROFILES).map((p) => ({
        mode: p.mode,
        label: p.label,
        description: p.description
      })),
      // Sent with the status so a webview that was recreated mid-turn shows
      // the phase it is actually in rather than nothing.
      state: this.session.currentState,
      stateLabel: describeState(this.session.currentState),
      autoApprove: s.autoApproveEdits,
      approveEverything: s.requireApprovalForAll
    };
  }

  /**
   * Sends a turn down whichever execution path is configured.
   *
   * `single` is the direct call this extension has always made. `coordinated`
   * runs the same work as a one-node graph so the Coordinator's task
   * lifecycle, locks and budget are exercised on real turns — with one agent
   * the visible result is the same, which is the point of introducing the
   * spine before the parallelism that rides on it.
   */
  private async dispatch(text: string, opts: SendOptions): Promise<void> {
    const settings = getSettings();
    if (settings.orchestration === 'multi-agent') {
      await this.runMultiAgent(text, settings);
      return;
    }
    if (settings.orchestration !== 'coordinated') {
      await this.session.send(text, opts);
      return;
    }

    const signal = { isCancellationRequested: false };
    const coordinator = new Coordinator({
      bus: this.bus,
      taskId: this.session.id,
      budget: settings.budget,
      concurrency: settings.concurrency
    });
    coordinator.addTask({
      id: 'chat',
      objective: text.slice(0, 200),
      role: 'chat',
      priority: 'high'
    });

    this.activeRun = { coordinator, signal };
    try {
      const outcome = await coordinator.run(async () => {
        await this.session.send(text, opts);
        return { ok: true };
      }, signal);

      // Only worth saying when something was cut short; a normal turn already
      // reports itself through the usual events.
      if (outcome.stoppedEarly && !signal.isCancellationRequested) {
        this.emit('notice', { message: outcome.summary });
      }
    } finally {
      this.activeRun = undefined;
    }
  }

  /**
   * The full coordinated run: parallel planning, scoped implementation,
   * independent verification, capped repair.
   *
   * It reports through the same event bus as everything else, so the panel
   * narrates it with the components it already has until the multi-agent UI
   * lands.
   */
  private async runMultiAgent(text: string, settings: Settings): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      this.emit('error', {
        message:
          'Multi-agent runs need an open folder, because every agent works against the workspace. Open a folder, or set "azureAiChat.orchestration" back to "single".'
      });
      return;
    }

    const controller = new AbortController();
    const cts = new vscode.CancellationTokenSource();
    const signal = { isCancellationRequested: false };
    this.activeRun = { coordinator: undefined, signal, controller, cts };

    this.emit('task.started', { mode: 'multi-agent' });
    this.emit('agent.state', { state: 'planning', label: 'Planning' });

    try {
      const result = await runMultiAgentTask({
        request: text,
        taskId: this.session.id,
        workspaceRoot: root.uri.fsPath,
        settings,
        provider: this.model,
        bus: this.bus,
        concurrency: settings.concurrency,
        maxVerificationAttempts: settings.maxVerificationAttempts,
        toolContext: {
          settings,
          edits: this.edits,
          commands: this.commands,
          recorder: this.recorder,
          onEditProposed: (info) => this.emit('file.edit.proposed', { ...info }),
          onCommandProposed: (info) => this.emit('command.proposed', { ...info }),
          onCommandFinished: (info) => this.emit('command.finished', { ...info }),
          token: cts.token
        },
        signal: controller.signal,
        token: cts.token,
        onProgress: (message) => this.emit('notice', { message })
      });

      // The report is the answer, so it goes through the text channel the
      // panel already renders as an assistant message.
      this.emit('model.started', {});
      this.emit('model.text', { delta: result.report });
      this.emit('agent.state', {
        state:
          result.state === 'completed'
            ? 'completed'
            : result.state === 'cancelled'
              ? 'cancelled'
              : 'failed',
        label: result.state === 'completed' ? 'Verified' : 'Not verified'
      });
      this.emit('model.completed', { usageNote: result.budget });
    } catch (err) {
      this.emit('error', { message: (err as Error).message });
    } finally {
      cts.dispose();
      this.activeRun = undefined;
    }
  }

  /** Generic so each call site is checked against that event's own payload. */
  private emit<T extends AgentEventType>(type: T, data: EventDataMap[T]): void {
    this.bus.emit({ type, taskId: this.session.id, data } as EmitOptions);
  }

  /**
   * Sends the webview everything it has not applied.
   *
   * A reloaded webview loses its whole DOM while the run keeps going here,
   * so it asks from sequence 0 and rebuilds the transcript from this log.
   * One that merely re-rendered asks only for the gap. Either way the task
   * does not restart, and the webview drops anything it has already seen by
   * `eventId`, so an overlapping range is safe.
   */
  private replay(lastSequence: number): void {
    const { events, gap } = this.bus.replaySince(
      this.session.id,
      Math.max(0, lastSequence)
    );
    if (events.length === 0 && !gap) {
      return;
    }
    // One message rather than one per event: a long run replays hundreds,
    // and the webview folds a batch in a single render.
    this.post({ type: 'replay', events, gap });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  /**
   * The webview shell.
   *
   * It is only a mount point: the UI is a React app built by Vite into
   * `media/webview`. Everything is loaded from disk under a strict CSP, with a
   * nonce on the script — no inline code, no remote origins.
   */
  private html(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const asset = (name: string): vscode.Uri =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview', name)
      );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};" />
<link href="${asset('app.css')}" rel="stylesheet" />
<title>AI Coding Assistant</title>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${asset('app.js')}"></script>
</body>
</html>`;
  }
}

function toChip(a: Attachment) {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    size: formatBytes(a.bytes),
    note: a.note,
    error: a.error,
    chars: a.text ? a.text.length : undefined
  };
}

function normaliseEffort(value: unknown): ReasoningEffort | undefined {
  const v = String(value ?? '');
  return v === 'minimal' || v === 'low' || v === 'medium' || v === 'high'
    ? v
    : undefined;
}

function summarizeArgs(raw: string): string {
  try {
    const o = JSON.parse(raw || '{}');
    if (typeof o.command === 'string') return o.command;
    if (typeof o.path === 'string') return o.path;
    if (typeof o.pattern === 'string') return `/${o.pattern}/`;
    if (typeof o.glob === 'string') return o.glob;
    if (typeof o.kind === 'string') return o.kind;
    return '';
  } catch {
    return '';
  }
}

function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
