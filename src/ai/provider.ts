import { ChatMessage, ReasoningEffort, StreamResult, ToolSpec } from '../azureClient';

/**
 * What the agent loop needs from a model, and nothing more.
 *
 * The loop in `chatSession` talks to this rather than to `azureClient`, so a
 * second provider (a different Azure resource, an OpenAI-compatible gateway, a
 * local model) can be added without touching the loop, the tools or the UI.
 * Everything Azure-specific — the two API surfaces, the SSE parsing, the
 * learned capability quirks — stays behind `AzureProvider`.
 */
export interface ChatRequest {
  messages: ChatMessage[];
  /** Empty disables tool calling for this request. */
  tools: ToolSpec[];
  /** Which model/deployment to use. Falls back to the provider's default. */
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ChatStreamHandlers {
  onText: (delta: string) => void;
  /** Reasoning *summary* text, when the model returns one. Never raw CoT. */
  onReasoning?: (delta: string) => void;
  /** A recoverable adjustment the user should be told about. */
  onNotice?: (message: string) => void;
}

export interface AIModelProvider {
  /** Stable identifier used in logs and telemetry. */
  readonly id: string;
  readonly displayName: string;

  /** Models this provider can serve right now. Empty when unconfigured. */
  listModels(): string[];

  supportsToolCalling(): boolean;
  supportsReasoning(): boolean;

  /**
   * Streams a completion, invoking `handlers` as deltas arrive, and resolves
   * with the assembled result including any tool calls.
   */
  stream(
    request: ChatRequest,
    handlers: ChatStreamHandlers,
    signal: AbortSignal
  ): Promise<StreamResult>;

  /** Non-streaming convenience: the same call, collected. */
  chat(request: ChatRequest, signal: AbortSignal): Promise<StreamResult>;
}

/**
 * Default `chat` for any provider that implements `stream`. Kept here so each
 * provider does not reimplement the collection.
 */
export function collectStream(
  provider: Pick<AIModelProvider, 'stream'>,
  request: ChatRequest,
  signal: AbortSignal
): Promise<StreamResult> {
  return provider.stream(request, { onText: () => undefined }, signal);
}
