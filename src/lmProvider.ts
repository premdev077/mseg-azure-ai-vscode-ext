import * as vscode from 'vscode';
import {
  ChatMessage,
  ToolCall,
  ToolSpec,
  streamChatCompletion
} from './azureClient';
import { getApiKey, getSettings, isConfigured } from './config';

export const VENDOR = 'azure-ai-chat';

/**
 * The message shape a provider receives. VS Code renamed this type between
 * 1.104 (`LanguageModelChatMessage`) and later releases
 * (`LanguageModelChatRequestMessage`), so it is read structurally here — the
 * fields are identical and this compiles against either @types/vscode.
 */
interface IncomingMessage {
  readonly role: number;
  readonly name?: string;
  readonly content: ReadonlyArray<unknown>;
}

/** Stable roles. There is no System role in the stable LM API. */
const ROLE_USER = 1;
const ROLE_ASSISTANT = 2;
const ROLE_SYSTEM = 3; // proposed-only; handled if it ever arrives

/**
 * Registers the configured Azure deployments as models in VS Code's own Chat
 * view. VS Code owns the conversation, the tools and the edit review; this
 * class only translates between VS Code's message parts and Azure's REST shape
 * and streams the reply back. It is deliberately stateless — the agent loop
 * lives in VS Code, not here.
 */
export class AzureLanguageModelProvider {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    _token: vscode.CancellationToken
  ): Promise<unknown[]> {
    const settings = getSettings();

    if (!isConfigured(settings)) {
      if (!options.silent) {
        void this.promptToConfigure();
      }
      return [];
    }

    const key = await getApiKey(this.ctx, settings);
    if (!key) {
      if (!options.silent) {
        const set = 'Set API Key';
        const choice = await vscode.window.showWarningMessage(
          'Azure AI Chat: no API key set for your Azure OpenAI endpoint.',
          set
        );
        if (choice === set) {
          await vscode.commands.executeCommand('azureAiChat.setApiKey');
        }
      }
      return [];
    }

    const host = safeHost(settings.endpoint);
    return settings.models.map((model) => ({
      id: model,
      name: model,
      family: 'azure-openai',
      version: settings.apiMode === 'v1' ? 'v1' : settings.apiVersion,
      maxInputTokens: 128000,
      maxOutputTokens: settings.maxTokens,
      tooltip: `Azure OpenAI deployment "${model}" on ${host}`,
      detail: host,
      capabilities: {
        toolCalling: true,
        imageInput: false
      }
    }));
  }

  async provideLanguageModelChatResponse(
    model: { id: string },
    messages: ReadonlyArray<IncomingMessage>,
    options: { tools?: ReadonlyArray<unknown>; modelOptions?: Record<string, unknown> },
    progress: vscode.Progress<unknown>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const settings = getSettings();
    const apiKey = await getApiKey(this.ctx, settings);
    if (!apiKey) {
      throw new Error(
        'Azure AI Chat: no API key set. Run "Azure AI Chat: Set API Key".'
      );
    }

    const converted = convertMessages(messages);
    if (settings.systemPrompt.trim()) {
      converted.unshift({ role: 'system', content: settings.systemPrompt.trim() });
    }

    const tools = convertTools(options.tools);

    // Bridge VS Code's CancellationToken to the fetch AbortController.
    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());

    try {
      const result = await streamChatCompletion(
        settings,
        apiKey,
        converted,
        tools,
        {
          onText: (delta) => {
            progress.report(new (vscode as any).LanguageModelTextPart(delta));
          }
        },
        controller.signal,
        { model: model.id }
      );

      for (const call of result.toolCalls) {
        progress.report(toToolCallPart(call));
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        return;
      }
      throw err;
    } finally {
      sub.dispose();
    }
  }

  /**
   * An estimate, not a tokeniser. Azure does not expose a counting endpoint and
   * bundling a BPE tokeniser for every model family is not worth the weight;
   * ~4 characters per token is close enough for VS Code's budgeting, and errs
   * slightly high so prompts are trimmed rather than rejected.
   */
  async provideTokenCount(
    _model: unknown,
    text: string | IncomingMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const raw =
      typeof text === 'string' ? text : partsToText(text.content ?? []);
    return Math.ceil(raw.length / 3.7);
  }

  private async promptToConfigure(): Promise<void> {
    const open = 'Open Settings';
    const choice = await vscode.window.showWarningMessage(
      'Azure AI Chat: set "azureAiChat.connection" with your endpoint, model (deployment name) and API key to use Azure models in Chat.',
      open
    );
    if (choice === open) {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'azureAiChat.connection'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Conversion between VS Code's part model and Azure's chat-completions shape.
// Parts are identified structurally rather than with instanceof, so the code
// survives the class renames between VS Code releases.
// ---------------------------------------------------------------------------

function isTextPart(p: any): p is { value: string } {
  return p && typeof p.value === 'string' && p.callId === undefined;
}

function isToolCallPart(
  p: any
): p is { callId: string; name: string; input: unknown } {
  return p && typeof p.callId === 'string' && typeof p.name === 'string';
}

function isToolResultPart(
  p: any
): p is { callId: string; content: unknown[] } {
  return (
    p &&
    typeof p.callId === 'string' &&
    typeof p.name !== 'string' &&
    Array.isArray(p.content)
  );
}

function partsToText(parts: ReadonlyArray<unknown>): string {
  return parts
    .map((p: any) => {
      if (isTextPart(p)) {
        return p.value;
      }
      if (typeof p === 'string') {
        return p;
      }
      if (p && typeof p.value === 'string') {
        return p.value;
      }
      return '';
    })
    .join('');
}

function toToolCallPart(call: ToolCall): unknown {
  let input: unknown = {};
  try {
    input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    // A model occasionally emits malformed JSON. Pass the raw string through
    // so the failure surfaces in the tool rather than silently becoming {}.
    input = { _raw: call.function.arguments };
  }
  return new (vscode as any).LanguageModelToolCallPart(
    call.id,
    call.function.name,
    input
  );
}

/**
 * VS Code delivers tool results inside User messages; Azure needs them as
 * separate `tool` messages keyed by call id. Splitting them out here is what
 * makes tool calling work end to end.
 */
export function convertMessages(
  messages: ReadonlyArray<IncomingMessage>
): ChatMessage[] {
  const out: ChatMessage[] = [];

  for (const msg of messages) {
    const parts = (msg.content ?? []) as any[];
    const toolResults = parts.filter(isToolResultPart);
    const toolCalls = parts.filter(isToolCallPart);
    const text = partsToText(parts.filter((p) => !isToolResultPart(p) && !isToolCallPart(p)));

    // Tool results must precede the message that follows them.
    for (const r of toolResults) {
      out.push({
        role: 'tool',
        tool_call_id: r.callId,
        content: partsToText(r.content) || '(no output)'
      });
    }

    if (msg.role === ROLE_ASSISTANT) {
      if (toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: text || null,
          tool_calls: toolCalls.map(
            (c): ToolCall => ({
              id: c.callId,
              type: 'function',
              function: {
                name: c.name,
                arguments:
                  typeof c.input === 'string'
                    ? c.input
                    : JSON.stringify(c.input ?? {})
              }
            })
          )
        });
      } else if (text) {
        out.push({ role: 'assistant', content: text });
      }
      continue;
    }

    if (msg.role === ROLE_SYSTEM) {
      if (text) {
        out.push({ role: 'system', content: text });
      }
      continue;
    }

    // ROLE_USER, and anything unrecognised, is treated as user text.
    if (text) {
      out.push({ role: 'user', content: text, name: sanitizeName(msg.name) });
    }
  }

  // Azure rejects a conversation whose first message is a tool result.
  while (out.length && out[0].role === 'tool') {
    out.shift();
  }
  if (out.length === 0) {
    out.push({ role: 'user', content: '(empty request)' });
  }
  return out;
}

/** Azure only accepts [A-Za-z0-9_-] in the optional message `name` field. */
function sanitizeName(name: string | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return cleaned || undefined;
}

/**
 * VS Code's tool descriptors carry their JSON Schema under `inputSchema`, but
 * older releases used `parametersSchema`. Both are accepted.
 */
export function convertTools(tools: ReadonlyArray<unknown> | undefined): ToolSpec[] {
  if (!tools || tools.length === 0) {
    return [];
  }
  const specs: ToolSpec[] = [];
  for (const t of tools as any[]) {
    if (!t || typeof t.name !== 'string') {
      continue;
    }
    const schema = t.inputSchema ?? t.parametersSchema ?? t.parameters;
    specs.push({
      type: 'function',
      function: {
        name: t.name,
        description: String(t.description ?? ''),
        parameters:
          schema && typeof schema === 'object'
            ? schema
            : { type: 'object', properties: {} }
      }
    });
  }
  return specs;
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/**
 * Registers the provider if this VS Code build has the API. Returns undefined
 * on older builds so the extension still loads and the sidebar keeps working.
 */
export function registerLanguageModelProvider(
  ctx: vscode.ExtensionContext
): vscode.Disposable | undefined {
  const lm = (vscode as any).lm;
  if (!lm || typeof lm.registerLanguageModelChatProvider !== 'function') {
    return undefined;
  }
  try {
    return lm.registerLanguageModelChatProvider(
      VENDOR,
      new AzureLanguageModelProvider(ctx)
    ) as vscode.Disposable;
  } catch (err) {
    console.warn('Azure AI Chat: could not register chat model provider', err);
    return undefined;
  }
}

export { ROLE_USER, ROLE_ASSISTANT, ROLE_SYSTEM };
export type { IncomingMessage };
