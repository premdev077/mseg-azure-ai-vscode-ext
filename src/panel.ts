import * as vscode from 'vscode';
import { ChatSession } from './chatSession';
import { EditReviewManager } from './editReview';
import { CommandApprovalManager } from './commandApproval';
import { SessionRecorder } from './history';
import { getSettings } from './config';
import {
  Attachment,
  attachmentPickerFilters,
  formatBytes,
  readAttachment
} from './attachments';
import { ReasoningEffort } from './azureClient';
import { ConversationStore, renderTranscript } from './conversations';

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

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly edits: EditReviewManager,
    private readonly commands: CommandApprovalManager,
    private readonly recorder: SessionRecorder,
    private readonly store: ConversationStore
  ) {
    this.session = new ChatSession(
      this.ctx,
      this.edits,
      this.commands,
      this.recorder,
      this.store,
      {
        onAssistantStart: () => this.post({ type: 'assistantStart' }),
        onText: (delta) => this.post({ type: 'assistantDelta', delta }),
        onReasoning: (delta) => this.post({ type: 'reasoningDelta', delta }),
        onToolStart: (name, args) =>
          this.post({ type: 'toolStart', name, args: summarizeArgs(args) }),
        onToolEnd: (name, preview) =>
          this.post({ type: 'toolEnd', name, preview }),
        onEditProposed: (info) => this.post({ type: 'editProposed', ...info }),
        onCommandProposed: (info) =>
          this.post({ type: 'commandProposed', ...info }),
        onCommandFinished: (info) =>
          this.post({ type: 'commandFinished', ...info }),
        onDone: (info) => this.post({ type: 'done', ...info }),
        onError: (message) => this.post({ type: 'error', message }),
        onContextAttached: (label) =>
          this.post({ type: 'contextAttached', label }),
        onNotice: (message) => this.post({ type: 'notice', message }),
        onConversationSaved: () => {
          if (this.historyOpen) {
            void this.sendHistory();
          }
        }
      }
    );

    this.ctx.subscriptions.push(
      this.edits.onDidResolve(({ id, decision }) =>
        this.post({ type: 'editResolved', id, decision })
      ),
      this.commands.onDidResolve(({ id, decision }) =>
        this.post({ type: 'commandResolved', id, decision })
      )
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

    view.webview.onDidReceiveMessage(async (msg: any) => {
      switch (msg?.type) {
        case 'ready':
          this.webviewReady = true;
          this.post({ type: 'status', ...this.statusPayload() });
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
          await this.session.send(String(msg.text ?? ''), {
            model: typeof msg.model === 'string' && msg.model ? msg.model : undefined,
            reasoningEffort: normaliseEffort(msg.reasoningEffort),
            attachments,
            attachEditorContext: msg.attachContext !== false
          });
          break;
        }

        case 'attach':
          await this.pickAttachments();
          break;

        case 'removeAttachment':
          this.staged.delete(String(msg.id));
          this.post({ type: 'attachments', items: this.chips() });
          break;

        case 'cancel':
          this.session.cancel();
          this.post({ type: 'cancelled' });
          break;

        case 'newChat':
          this.session.reset();
          this.staged.clear();
          this.post({ type: 'cleared' });
          break;

        case 'acceptEdit':
          try {
            if (!(await this.edits.accept(String(msg.id)))) {
              this.post({ type: 'editExpired', id: msg.id });
            }
          } catch (e) {
            this.post({
              type: 'error',
              message: `Could not write the file: ${(e as Error).message}`
            });
          }
          break;

        case 'rejectEdit':
          if (!this.edits.reject(String(msg.id))) {
            this.post({ type: 'editExpired', id: msg.id });
          }
          break;

        case 'approveCommand':
          if (!this.commands.approve(String(msg.id))) {
            this.post({ type: 'commandExpired', id: msg.id });
          }
          break;

        case 'rejectCommand':
          if (!this.commands.reject(String(msg.id))) {
            this.post({ type: 'commandExpired', id: msg.id });
          }
          break;

        case 'openDiff': {
          const edit = this.edits.get(String(msg.id));
          if (edit) {
            await this.edits.showDiff(edit);
          } else {
            this.post({ type: 'editExpired', id: msg.id });
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
          await this.openConversation(String(msg.id));
          break;

        case 'deleteConversation':
          await this.store.delete(String(msg.id));
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

        case 'copy':
          await vscode.env.clipboard.writeText(String(msg.text ?? ''));
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
            b.replace(editor.selection, String(msg.text ?? ''))
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
      this.post({
        type: 'error',
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
      autoApprove: s.autoApproveEdits,
      approveEverything: s.requireApprovalForAll
    };
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'main.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};" />
<link href="${styleUri}" rel="stylesheet" />
<title>Azure AI Chat</title>
</head>
<body>
  <div id="banner" class="banner hidden"></div>
  <div id="notices" class="notices"></div>

  <div id="historyPanel" class="history-panel hidden">
    <div class="history-head">
      <strong>History</strong>
      <span class="spacer"></span>
      <button id="historyClose" class="link-btn">Close</button>
    </div>
    <div id="historyList" class="history-list"></div>
    <div id="historyFolder" class="history-folder"></div>
  </div>

  <div id="messages" class="messages">
    <div class="empty" id="empty">
      <h3>Azure AI Chat</h3>
      <p>Ask about your code, attach files to read, or describe a change and review the diff before it lands.</p>
      <ul>
        <li>“Where is authentication handled in this project?”</li>
        <li>“Run the type-check and fix whatever it reports.”</li>
        <li>“Read the attached spec and tell me what's missing.”</li>
      </ul>
    </div>
  </div>

  <div class="composer">
    <div id="attachments" class="attachments hidden"></div>

    <div class="composer-box">
      <textarea id="input" rows="3" placeholder="Ask anything, or describe a change…"></textarea>
    </div>

    <div class="controls">
      <button id="attach" class="icon-btn" title="Attach files (images, PDF, Word, Excel, PowerPoint, text, code)">
        <span class="plus">+</span> Attach
      </button>

      <label class="field" title="Which Azure deployment to send this to">
        <select id="model" aria-label="Model"></select>
      </label>

      <label class="field" title="Reasoning effort. Only reasoning deployments (o-series, GPT-5 family) accept this.">
        <select id="effort" aria-label="Thinking">
          <option value="">Thinking: default</option>
          <option value="none">Thinking: none</option>
          <option value="minimal">Thinking: minimal</option>
          <option value="low">Thinking: low</option>
          <option value="medium">Thinking: medium</option>
          <option value="high">Thinking: high</option>
        </select>
      </label>

      <label class="ctx-toggle" title="Attach the active editor file and selection to your next message">
        <input type="checkbox" id="attachContext" checked />
        <span>Active file</span>
      </label>

      <span class="spacer"></span>
      <button id="stop" class="stop hidden">Stop</button>
      <button id="send" class="send">Send</button>
    </div>

    <div class="footer-row">
      <span id="hint" class="hint">Enter to send · Shift+Enter for a new line</span>
    </div>
  </div>
<script nonce="${nonce}" src="${scriptUri}"></script>
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
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
