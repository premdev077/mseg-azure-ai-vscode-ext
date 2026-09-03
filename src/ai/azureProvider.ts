import { StreamResult, streamChatCompletion } from '../azureClient';
import { Settings } from '../config';
import {
  AIModelProvider,
  ChatRequest,
  ChatStreamHandlers,
  collectStream
} from './provider';

/**
 * The Azure OpenAI provider: a thin adapter over `azureClient`, which keeps
 * the SSE parsing, the v1/classic surfaces and the learned capability quirks
 * exactly where they already were.
 *
 * Settings and the API key are read through callbacks rather than captured,
 * so a settings change or a re-keyed session is picked up without rebuilding
 * the provider.
 */
export class AzureProvider implements AIModelProvider {
  readonly id = 'azure-openai';
  readonly displayName = 'Azure OpenAI';

  constructor(
    private readonly readSettings: () => Settings,
    private readonly readApiKey: () => Promise<string | undefined>
  ) {}

  listModels(): string[] {
    return this.readSettings().models;
  }

  supportsToolCalling(): boolean {
    return true;
  }

  /**
   * Only reasoning deployments accept `reasoning_effort`, and there is no
   * capability endpoint that reports which those are. `azureClient` learns the
   * conflict from a 400 and retries without it, so this is true and the
   * per-deployment truth is handled a layer down.
   */
  supportsReasoning(): boolean {
    return true;
  }

  async stream(
    request: ChatRequest,
    handlers: ChatStreamHandlers,
    signal: AbortSignal
  ): Promise<StreamResult> {
    const settings = this.readSettings();
    const apiKey = await this.readApiKey();
    if (!apiKey) {
      throw new Error(
        'No API key set. Run the command "Azure AI Chat: Set API Key" and try again.'
      );
    }

    return streamChatCompletion(
      settings,
      apiKey,
      request.messages,
      request.tools,
      {
        onText: handlers.onText,
        onReasoning: handlers.onReasoning,
        onNotice: handlers.onNotice
      },
      signal,
      { model: request.model, reasoningEffort: request.reasoningEffort }
    );
  }

  chat(request: ChatRequest, signal: AbortSignal): Promise<StreamResult> {
    return collectStream(this, request, signal);
  }
}
