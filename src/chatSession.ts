import * as vscode from 'vscode';
import { ChatMessage, ContentPart, ReasoningEffort, ToolCall } from './azureClient';
import { AIModelProvider } from './ai/provider';
import { AgentMode, modeProfile } from './agent/mode';
import { AgentState, stateForTool } from './agent/state';
import { invalidRoleAssignments, resolveRoleModel } from './agent/roles';
import { Attachment, attachmentsToContentParts } from './attachments';
import { ConversationStore, StoredConversation, deriveTitle } from './conversations';
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
  /** The agent's state changed. Drives the progress UI. */
  onState: (state: AgentState) => void;
  /** Token usage for one model round, when the deployment reports it. */
  onUsage?: (usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  }) => void;
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
  /** Operating mode for this turn. Falls back to the configured default. */
  mode?: AgentMode;
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
  private state: AgentState = 'idle';
  /** Misrouted roles are reported once, not on every turn. */
  private warnedAboutRoles = false;

  /**
   * Identifies this session as an agent to the approval gates, so cancelling
   * it rejects only the edits and commands it raised. Today there is one
   * session, but the gates are shared and the Coordinator will run several.
   */
  private readonly agentId: string;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly edits: EditReviewManager,
    private readonly commands: CommandApprovalManager,
    private readonly recorder: SessionRecorder,
    private readonly store: ConversationStore,
    private readonly provider: AIModelProvider,
    private readonly events: SessionEvents,
    agentId?: string
  ) {
    this.agentId = agentId ?? `chat-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** Who this session is, for event correlation and approval ownership. */
  get ownerId(): string {
    return this.agentId;
  }

  get currentState(): AgentState {
    return this.state;
  }

  /** Single point of truth for the state, so the UI never misses a change. */
  private setState(state: AgentState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.events.onState(state);
  }

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
    this.setState('idle');
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
      workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? '(no folder)',
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
    this.warnedAboutRoles = false;
    this.setState('idle');
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
    // Scoped to this agent: another agent's pending review must survive.
    this.edits.rejectAll(this.agentId);
    this.commands.rejectAll(this.agentId);
    if (this.state !== 'idle') {
      this.setState('cancelled');
    }
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
    const mode: AgentMode = opts.mode ?? settings.defaultMode;

    try {
      this.setState('analyzing');
      this.reportRoleProblems(settings);

      // Keep the system prompt current without ever clobbering a non-system
      // message at index 0 (which cancellation races could leave there).
      const system: ChatMessage = {
        role: 'system',
        content: withUserPrompt(buildSystemPrompt(settings, mode), settings)
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
      this.lastModel = opts.model ?? this.roleModel(settings);

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

      await this.runAgentLoop(settings, mode, myTurn, controller, cts, opts);
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError' && myTurn === this.turnId) {
        this.setState('failed');
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
    mode: AgentMode,
    myTurn: number,
    controller: AbortController,
    cts: vscode.CancellationTokenSource,
    opts: SendOptions
  ): Promise<void> {
    const profile = modeProfile(mode);
    let iterations = 0;
    let totalCompletionTokens = 0;
    let totalReasoningTokens = 0;

    // Fast mode gets read-only tools; the other modes get everything.
    const allowed = profile.allowedTools;
    const tools = allowed
      ? TOOL_SPECS.filter((t) => allowed.includes(t.function.name))
      : TOOL_SPECS;

    // A name in the allowlist that no longer matches a spec would silently
    // remove a tool from the mode, which is very hard to notice from the
    // outside. Say so rather than quietly degrading.
    if (allowed && tools.length !== allowed.length) {
      const present = new Set(tools.map((t) => t.function.name));
      const missing = allowed.filter((name) => !present.has(name));
      this.events.onNotice(
        `${profile.label} mode expected the tool(s) ${missing.join(', ')}, which are not registered. This is a bug in the extension, not in your request.`
      );
    }

    // The mode's cap and the user's setting both apply — the lower wins, so
    // raising maxToolIterations never makes Fast mode grind.
    const maxRounds = Math.max(
      1,
      Math.min(
        settings.maxToolIterations,
        profile.toolRoundCap ?? settings.maxToolIterations
      )
    );

    // The composer's Thinking selector wins; the mode only supplies a default.
    const reasoningEffort = opts.reasoningEffort ?? profile.defaultReasoningEffort;

    // Precedence: what the composer picked, then the role assignment, then the
    // first configured deployment.
    const model = opts.model ?? this.roleModel(settings);

    while (iterations < maxRounds) {
      iterations += 1;
      this.trimHistory();
      this.events.onAssistantStart();

      const result = await this.provider.stream(
        {
          messages: this.messages,
          tools,
          model,
          reasoningEffort
        },
        {
          onText: (d) => this.events.onText(d),
          onReasoning: (d) => this.events.onReasoning(d),
          onNotice: (m) => this.events.onNotice(m)
        },
        controller.signal
      );

      // The turn was cancelled (or replaced) while we were streaming: drop
      // everything rather than writing into a history that has moved on.
      if (myTurn !== this.turnId) {
        return;
      }

      totalCompletionTokens += result.usage?.completion_tokens ?? 0;
      totalReasoningTokens +=
        result.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      if (result.usage) {
        this.events.onUsage?.(result.usage);
      }

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: result.content || null
      };
      if (result.toolCalls.length > 0) {
        assistantMsg.tool_calls = result.toolCalls;
      }
      this.messages.push(assistantMsg);

      if (result.toolCalls.length === 0) {
        this.setState('completed');
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

    this.setState('failed');
    this.events.onError(
      profile.toolRoundCap !== undefined && maxRounds === profile.toolRoundCap
        ? `Stopped after ${maxRounds} tool rounds, which is ${profile.label} mode's limit. Re-send this in Thinking or Agent mode if it genuinely needs more steps.`
        : `Stopped after ${maxRounds} tool rounds. Raise "azureAiChat.maxToolIterations" if this task legitimately needs more steps.`
    );
  }

  /** The deployment assigned to the sidebar chat, or the default. */
  private roleModel(settings: Settings): string {
    return resolveRoleModel(
      'chat',
      settings.modelRoles,
      settings.models,
      settings.deployment
    ).model;
  }

  /**
   * Tells the user once when a role names a deployment that is not configured.
   * Silently falling back would mean their routing quietly does nothing.
   */
  private reportRoleProblems(settings: Settings): void {
    if (this.warnedAboutRoles) {
      return;
    }
    const problems = invalidRoleAssignments(
      settings.modelRoles,
      settings.models,
      settings.deployment
    );
    if (problems.length > 0) {
      this.warnedAboutRoles = true;
      this.events.onNotice(problems.join(' '));
    }
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
      this.setState(stateForTool(call.function.name));
      this.events.onToolStart(call.function.name, call.function.arguments);

      const output = await runTool(call.function.name, call.function.arguments, {
        settings,
        owner: this.agentId,
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
