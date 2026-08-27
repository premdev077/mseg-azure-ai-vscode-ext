import * as vscode from 'vscode';
import {
  ChatMessage,
  ContentPart,
  ReasoningEffort,
  streamChatCompletion,
  ToolCall
} from './azureClient';
import { Attachment, attachmentsToContentParts } from './attachments';
import {
  ConversationStore,
  StoredConversation,
  deriveTitle
} from './conversations';
import { getApiKey, getSettings, promptForApiKey, Settings } from './config';
import { EditReviewManager } from './editReview';
import { CommandApprovalManager } from './commandApproval';
import { SessionRecorder } from './history';
import { runTool, TOOL_SPECS } from './tools';
import {
  buildSystemPrompt,
  captureEditorContext,
  renderEditorContext,
  withUserPrompt
} from './prompt';

export interface SessionEvents {
  onAssistantStart: () => void;
  onText: (delta: string) => void;
  onToolStart: (name: string, args: string) => void;
  onToolEnd: (name: string, resultPreview: string) => void;
  onEditProposed: (info: {
    id: string;
    relPath: string;
    added: number;
    removed: number;
    isNewFile: boolean;
  }) => void;
  onDone: (info: { usageNote?: string }) => void;
  onError: (message: string) => void;
  onContextAttached: (label: string) => void;
  onReasoning: (delta: string) => void;
  onNotice: (message: string) => void;
  onConversationSaved: () => void;
  onCommandProposed: (info: {
    id: string;
    command: string;
    cwd: string;
    reason: string;
    autoRun: boolean;
  }) => void;
  onCommandFinished: (info: {
    id: string;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
    output: string;
  }) => void;
}

export interface SendOptions {
  /** Deployment picked in the composer. Falls back to the first configured. */
  model?: string;
  reasoningEffort?: ReasoningEffort;
  attachments?: Attachment[];
  attachEditorContext?: boolean;
}

/** Roughly 4 characters per token; used only to decide when to trim history. */
const CHAR_BUDGET = 400_000;

export class ChatSession {
  private messages: ChatMessage[] = [];
  private controller: AbortController | undefined;
  private cts: vscode.CancellationTokenSource | undefined;
  private running = false;
  /** Incremented per turn; a cancelled turn's late continuations check this. */
  private turnId = 0;
  private conversationId = newConversationId();
  private createdAt = new Date().toISOString();
  private lastModel: string | undefined;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly edits: EditReviewManager,
    private readonly commands: CommandApprovalManager,
    private readonly recorder: SessionRecorder,
    private readonly store: ConversationStore,
    private readonly events: SessionEvents
  ) {}

  get id(): string {
    return this.conversationId;
  }

  /** True once there is something worth saving. */
  get hasContent(): boolean {
    return this.messages.some((m) => m.role === 'user');
  }

  /** Replaces the conversation with a stored one so it can be continued. */
  loadConversation(conversation: StoredConversation): void {
    this.cancel();
    this.messages = conversation.messages.slice();
    this.conversationId = conversation.id;
    this.createdAt = conversation.createdAt;
    this.lastModel = conversation.model;
    this.recorder.reset();
    if (conversation.title) {
      this.recorder.setTask(conversation.title);
    }
  }

  private async persist(): Promise<void> {
    if (!this.hasContent) {
      return;
    }
    await this.store.save({
      id: this.conversationId,
      title: deriveTitle(this.messages),
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      workspace:
        vscode.workspace.workspaceFolders?.[0]?.name ?? '(no folder)',
      model: this.lastModel,
      messages: this.messages
    });
    this.events.onConversationSaved();
  }

  get isRunning(): boolean {
    return this.running;
  }

  reset(): void {
    void this.persist();
    this.cancel();
    this.messages = [];
    this.conversationId = newConversationId();
    this.createdAt = new Date().toISOString();
    this.recorder.reset();
  }

  /**
   * Aborts the in-flight turn. `running` is deliberately NOT cleared here — the
   * owning turn's `finally` does that, so a new turn can never start while the
   * old one is still unwinding and tear down the new turn's controller.
   */
  cancel(): void {
    this.turnId += 1;
    this.controller?.abort();
    this.cts?.cancel();
    this.edits.rejectAll();
    this.commands.rejectAll();
  }

  async send(userText: string, opts: SendOptions = {}): Promise<void> {
    const attachEditorContext = opts.attachEditorContext !== false;
    if (this.running) {
      this.events.onError('A response is already in progress.');
      return;
    }

    const settings = getSettings();
    let apiKey = await getApiKey(this.ctx);
    if (!apiKey) {
      apiKey = await promptForApiKey(this.ctx);
      if (!apiKey) {
        this.events.onError(
          'No API key set. Run the command "Azure AI Chat: Set API Key" and try again.'
        );
        return;
      }
    }
    if (!settings.endpoint || !settings.deployment) {
      this.events.onError(
        'Set `azureAiChat.connection` → endpoint and model in Settings before sending a message.'
      );
      return;
    }

    this.turnId += 1;
    const myTurn = this.turnId;
    this.running = true;
    const controller = new AbortController();
    const cts = new vscode.CancellationTokenSource();
    this.controller = controller;
    this.cts = cts;

    try {
      // Keep the system prompt current without ever clobbering a non-system
      // message at index 0 (which cancellation races could leave there).
      const system: ChatMessage = {
        role: 'system',
        content: withUserPrompt(buildSystemPrompt(settings), settings)
      };
      if (this.messages[0]?.role === 'system') {
        this.messages[0] = system;
      } else {
        this.messages.unshift(system);
      }

      let leading = '';
      if (attachEditorContext && settings.includeActiveFile) {
        const editorCtx = captureEditorContext(settings);
        if (editorCtx) {
          leading = `${renderEditorContext(editorCtx)}\n\n`;
          this.events.onContextAttached(
            editorCtx.selection
              ? `${editorCtx.relPath} (lines ${editorCtx.selectionStartLine}-${editorCtx.selectionEndLine})`
              : editorCtx.relPath
          );
        }
      }

      this.recorder.setTask(userText);
      this.lastModel = opts.model ?? settings.deployment;

      const attachments = opts.attachments ?? [];
      if (attachments.length > 0) {
        // Attachments first, question last: the model reads the request in the
        // context of the material rather than the other way round.
        const parts: ContentPart[] = attachmentsToContentParts(attachments);
        if (leading) {
          parts.unshift({ type: 'text', text: leading.trim() });
        }
        parts.push({ type: 'text', text: userText });
        this.messages.push({ role: 'user', content: parts });
      } else {
        this.messages.push({ role: 'user', content: `${leading}${userText}` });
      }

      await this.runAgentLoop(settings, apiKey, myTurn, controller, cts, opts);
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError' && myTurn === this.turnId) {
        this.events.onError((err as Error).message);
      }
    } finally {
      cts.dispose();
      if (this.controller === controller) {
        this.controller = undefined;
      }
      if (this.cts === cts) {
        this.cts = undefined;
      }
      this.running = false;
      if (myTurn === this.turnId) {
        await this.persist();
      }
    }
  }

  private async runAgentLoop(
    settings: Settings,
    apiKey: string,
    myTurn: number,
    controller: AbortController,
    cts: vscode.CancellationTokenSource,
    opts: SendOptions
  ): Promise<void> {
    let iterations = 0;
    let totalCompletionTokens = 0;
    let totalReasoningTokens = 0;

    while (iterations < Math.max(1, settings.maxToolIterations)) {
      iterations += 1;
      this.trimHistory();
      this.events.onAssistantStart();

      const result = await streamChatCompletion(
        settings,
        apiKey,
        this.messages,
        TOOL_SPECS,
        {
          onText: (d) => this.events.onText(d),
          onReasoning: (d) => this.events.onReasoning(d),
          onNotice: (m) => this.events.onNotice(m)
        },
        controller.signal,
        { model: opts.model, reasoningEffort: opts.reasoningEffort }
      );

      // The turn was cancelled (or replaced) while we were streaming: drop
      // everything rather than writing into a history that has moved on.
      if (myTurn !== this.turnId) {
        return;
      }

      totalCompletionTokens += result.usage?.completion_tokens ?? 0;
      totalReasoningTokens +=
        result.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: result.content || null
      };
      if (result.toolCalls.length > 0) {
        assistantMsg.tool_calls = result.toolCalls;
      }
      this.messages.push(assistantMsg);

      if (result.toolCalls.length === 0) {
        this.events.onDone({
          usageNote: totalCompletionTokens
            ? `${totalCompletionTokens} completion tokens` +
              (totalReasoningTokens ? ` (${totalReasoningTokens} reasoning)` : '')
            : undefined
        });
        return;
      }

      const completed = await this.executeToolCalls(
        result.toolCalls,
        settings,
        myTurn,
        cts
      );
      if (!completed || cts.token.isCancellationRequested) {
        return;
      }
    }

    this.events.onError(
      `Stopped after ${settings.maxToolIterations} tool rounds. Raise "azureAiChat.maxToolIterations" if this task legitimately needs more steps.`
    );
  }

  /**
   * Runs each tool call and appends its result. Returns false if the turn was
   * cancelled part-way; in that case the caller must not continue, because the
   * assistant's tool_calls message may no longer have a full set of results.
   */
  private async executeToolCalls(
    toolCalls: ToolCall[],
    settings: Settings,
    myTurn: number,
    cts: vscode.CancellationTokenSource
  ): Promise<boolean> {
    for (const call of toolCalls) {
      this.events.onToolStart(call.function.name, call.function.arguments);

      const output = await runTool(call.function.name, call.function.arguments, {
        settings,
        edits: this.edits,
        commands: this.commands,
        recorder: this.recorder,
        onEditProposed: (info) => {
          if (myTurn === this.turnId) {
            this.events.onEditProposed(info);
          }
        },
        onCommandProposed: (info) => {
          if (myTurn === this.turnId) {
            this.events.onCommandProposed(info);
          }
        },
        onCommandFinished: (info) => {
          if (myTurn === this.turnId) {
            this.events.onCommandFinished(info);
          }
        },
        token: cts.token
      });

      if (myTurn !== this.turnId) {
        return false;
      }

      this.events.onToolEnd(call.function.name, output.slice(0, 200));
      this.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: output
      });
    }
    return true;
  }

  /**
   * Drops the oldest exchanges once history gets long. Trimming always removes
   * whole turns — an assistant message carrying tool_calls is never separated
   * from its tool results, since Azure rejects an orphaned `tool` message.
   */
  private trimHistory(): void {
    const contentLength = (m: ChatMessage): number => {
      if (typeof m.content === 'string') {
        return m.content.length;
      }
      if (Array.isArray(m.content)) {
        return m.content.reduce(
          (n, p) =>
            n +
            (p.type === 'text'
              ? p.text.length
              : // A base64 image costs far more than its characters suggest.
                Math.ceil(p.image_url.url.length / 2)),
          0
        );
      }
      return 0;
    };

    const size = () =>
      this.messages.reduce(
        (n, m) => n + contentLength(m) + (m.tool_calls ? 400 : 0),
        0
      );

    // Index of the final user message: never trim the question being asked.
    const lastUserIndex = () => {
      for (let i = this.messages.length - 1; i > 0; i--) {
        if (this.messages[i].role === 'user') {
          return i;
        }
      }
      return -1;
    };

    while (size() > CHAR_BUDGET && lastUserIndex() > 1) {
      // Remove the oldest user turn, then every assistant/tool message that
      // belongs to it, stopping at the next user message.
      this.messages.splice(1, 1);
      while (
        this.messages.length > 1 &&
        this.messages[1].role !== 'user' &&
        lastUserIndex() > 1
      ) {
        this.messages.splice(1, 1);
      }
    }

    // Belt and braces: a `tool` message can never lead the history.
    while (this.messages.length > 1 && this.messages[1].role === 'tool') {
      this.messages.splice(1, 1);
    }
  }
}


function newConversationId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}
