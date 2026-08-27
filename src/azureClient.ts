import { Settings, chatCompletionsUrl } from './config';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface ChatMessage {
  role: Role;
  /**
   * A plain string, or the multimodal parts array that vision-capable Azure
   * deployments accept. `null` is used by assistant messages that carry only
   * tool calls.
   */
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamHandlers {
  onText: (delta: string) => void;
  onToolCallProgress?: (name: string) => void;
  /** Reasoning summary text, when the deployment streams one. */
  onReasoning?: (delta: string) => void;
  /** A recoverable adjustment the user should know about. */
  onNotice?: (message: string) => void;
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface RequestOptions {
  /** Deployment to call. Defaults to the first configured model. */
  model?: string;
  /** Sent as `reasoning_effort`; ignored by non-reasoning deployments. */
  reasoningEffort?: ReasoningEffort;
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

/**
 * Streams a chat completion from Azure OpenAI.
 * Works against both the versionless /openai/v1 surface and the classic
 * /openai/deployments/{name}?api-version= surface.
 */
/**
 * The classic surface authenticates with the `api-key` header; the v1 surface
 * is OpenAI-compatible and takes a bearer token. Sending both can cause Azure
 * to evaluate the wrong one, so send exactly the one that surface expects.
 */
export function buildAuthHeaders(
  settings: Settings,
  apiKey: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (settings.apiMode === 'v1') {
    headers.Authorization = `Bearer ${apiKey}`;
  } else {
    headers['api-key'] = apiKey;
  }
  return headers;
}

/**
 * Some Azure deployments refuse `reasoning_effort` and function tools in the
 * same /chat/completions request (gpt-5.x on this surface, for one). There is
 * no capability endpoint that reports this, so it is learned from the 400 and
 * remembered for the rest of the session.
 */
const noToolsWithReasoning = new Set<string>();

function isReasoningToolConflict(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('reasoning_effort') &&
    (m.includes('function tool') || m.includes('tools')) &&
    (m.includes('not supported') || m.includes('unsupported'))
  );
}

export async function streamChatCompletion(
  settings: Settings,
  apiKey: string,
  messages: ChatMessage[],
  tools: ToolSpec[],
  handlers: StreamHandlers,
  signal: AbortSignal,
  request: RequestOptions = {}
): Promise<StreamResult> {
  const deployment = request.model || settings.deployment;
  const wantsReasoning = Boolean(request.reasoningEffort) && request.reasoningEffort !== 'none';

  // Known conflict: drop the effort up front rather than spending a round trip
  // discovering it again.
  if (tools.length > 0 && wantsReasoning && noToolsWithReasoning.has(deployment)) {
    return streamOnce(settings, apiKey, messages, tools, handlers, signal, {
      ...request,
      reasoningEffort: undefined
    });
  }

  try {
    return await streamOnce(settings, apiKey, messages, tools, handlers, signal, request);
  } catch (err) {
    const message = (err as Error)?.message ?? '';
    if (
      tools.length > 0 &&
      wantsReasoning &&
      isReasoningToolConflict(message) &&
      !signal.aborted
    ) {
      noToolsWithReasoning.add(deployment);
      handlers.onNotice?.(
        `"${deployment}" does not accept a thinking level together with tools on this API, so this request was sent without one. Tools are more useful here than a thinking level, so the rest of this session will do the same.`
      );
      return streamOnce(settings, apiKey, messages, tools, handlers, signal, {
        ...request,
        reasoningEffort: undefined
      });
    }
    throw err;
  }
}

/** Resets the learned capability cache — used when the connection changes. */
export function clearCapabilityCache(): void {
  noToolsWithReasoning.clear();
}

async function streamOnce(
  settings: Settings,
  apiKey: string,
  messages: ChatMessage[],
  tools: ToolSpec[],
  handlers: StreamHandlers,
  signal: AbortSignal,
  request: RequestOptions = {}
): Promise<StreamResult> {
  const deployment = request.model || settings.deployment;
  const url = chatCompletionsUrl(settings, deployment);

  const body: Record<string, unknown> = {
    messages,
    stream: true
  };

  // The v1 surface routes on `model`; classic routes on the URL path.
  // stream_options is only requested on v1, where it is always supported —
  // older classic api-versions reject the unknown field with a 400.
  if (settings.apiMode === 'v1') {
    body.model = deployment;
    body.stream_options = { include_usage: true };
  }

  const reasoning =
    request.reasoningEffort && request.reasoningEffort !== 'none'
      ? request.reasoningEffort
      : undefined;
  const explicitNone = request.reasoningEffort === 'none';

  // Reasoning deployments reject `max_tokens` and a custom `temperature`;
  // asking for a reasoning effort implies that family, so switch shape here
  // rather than making the user also flip the setting.
  if (settings.useMaxCompletionTokens || reasoning || explicitNone) {
    body.max_completion_tokens = settings.maxTokens;
  } else {
    body.max_tokens = settings.maxTokens;
    body.temperature = settings.temperature;
  }

  if (reasoning) {
    body.reasoning_effort = reasoning;
  } else if (explicitNone) {
    // Some deployments require this to be stated explicitly before they will
    // accept function tools.
    body.reasoning_effort = 'none';
  }

  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const headers = buildAuthHeaders(settings, apiKey);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    });
  } catch (err: unknown) {
    if ((err as Error)?.name === 'AbortError') {
      throw err;
    }
    throw new Error(
      `Could not reach ${url}. Check the endpoint, your network, and any corporate proxy. (${
        (err as Error).message
      })`
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(formatApiError(res.status, text, settings, deployment));
  }
  if (!res.body) {
    throw new Error('Azure OpenAI returned an empty response body.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningText = '';
  let finishReason: string | null = null;
  let usage: StreamResult['usage'];
  const toolAcc = new Map<number, ToolCallAccumulator>();
  const announced = new Set<number>();

  try {
    return await readStream();
  } finally {
    // Release the socket on every exit path, including [DONE] and throws.
    await reader.cancel().catch(() => undefined);
  }

  async function readStream(): Promise<StreamResult> {
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    let sep: number;
    while ((sep = indexOfFrameEnd(buffer)) !== -1) {
      const rawFrame = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^(\r?\n){1,2}/, '');

      for (const line of rawFrame.split(/\r?\n/)) {
        if (!line.startsWith('data:')) {
          continue;
        }
        const data = line.slice(5).trim();
        if (data === '' ) {
          continue;
        }
        if (data === '[DONE]') {
          buffer = '';
          return finish();
        }

        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        if (chunk.usage) {
          usage = chunk.usage;
        }

        const choice = chunk.choices?.[0];
        if (!choice) {
          continue;
        }
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        const delta = choice.delta;
        if (!delta) {
          continue;
        }

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          content += delta.content;
          handlers.onText(delta.content);
        }

        // Some deployments stream a reasoning summary alongside the answer.
        const reasoningDelta =
          typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : typeof delta.reasoning === 'string'
              ? delta.reasoning
              : undefined;
        if (reasoningDelta) {
          reasoningText += reasoningDelta;
          handlers.onReasoning?.(reasoningDelta);
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx: number = tc.index ?? 0;
            const existing =
              toolAcc.get(idx) ?? { id: '', name: '', args: '' };
            if (tc.id) {
              existing.id = tc.id;
            }
            if (tc.function?.name) {
              existing.name += tc.function.name;
            }
            if (tc.function?.arguments) {
              existing.args += tc.function.arguments;
            }
            toolAcc.set(idx, existing);
            if (existing.name && !announced.has(idx)) {
              announced.add(idx);
              handlers.onToolCallProgress?.(existing.name);
            }
          }
        }
      }
    }
  }

  return finish();
  }

  function finish(): StreamResult {
    const toolCalls: ToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, t]) => ({
        id: t.id || `call_${idx}`,
        type: 'function' as const,
        function: { name: t.name, arguments: t.args || '{}' }
      }));
    return { content, reasoning: reasoningText, toolCalls, finishReason, usage };
  }
}

function indexOfFrameEnd(buffer: string): number {
  const a = buffer.indexOf('\n\n');
  const b = buffer.indexOf('\r\n\r\n');
  if (a === -1) {
    return b;
  }
  if (b === -1) {
    return a;
  }
  return Math.min(a, b);
}

function formatApiError(
  status: number,
  body: string,
  s: Settings,
  deployment: string
): string {
  let detail = body;
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message ?? parsed?.message ?? body;
  } catch {
    /* keep raw body */
  }
  const trimmed = (detail || '').slice(0, 800);

  switch (status) {
    case 401:
      return `401 Unauthorized — the API key was rejected. Run "Azure AI Chat: Set API Key" (or fix apiKey in "azureAiChat.connection") for a current key for ${s.endpoint}. ${trimmed}`;
    case 403:
      return `403 Forbidden — the key is valid but not permitted for this resource or deployment, or the request was blocked by a network policy. ${trimmed}`;
    case 404:
      return `404 Not Found — check that deployment "${deployment}" exists on ${s.endpoint}. If your resource predates the v1 API, set "azureAiChat.apiMode" to "classic". ${trimmed}`;
    case 429:
      return `429 Rate limited — your deployment is at capacity. Wait a moment and retry, or raise the TPM quota on the deployment. ${trimmed}`;
    case 400: {
      const hints: string[] = [];
      const low = trimmed.toLowerCase();
      if (low.includes('max_tokens')) {
        hints.push(
          'Turn on "azureAiChat.useMaxCompletionTokens" — reasoning deployments require max_completion_tokens instead.'
        );
      }
      if (low.includes('temperature')) {
        hints.push('This deployment does not accept a custom temperature.');
      }
      if (isReasoningToolConflict(trimmed)) {
        hints.push(
          `"${deployment}" cannot combine a thinking level with tools on /chat/completions. Set Thinking to "none" (or "default") in the composer.`
        );
      }
      if (low.includes('image') || low.includes('image_url')) {
        hints.push(
          `"${deployment}" may not be a vision deployment. Remove the image attachments, or point at one that supports image input.`
        );
      }
      return hints.length
        ? `400 Bad Request — ${trimmed}\n\n${hints.join('\n')}`
        : `400 Bad Request — ${trimmed}`;
    }
    default:
      return `Azure OpenAI returned ${status}. ${trimmed}`;
  }
}
