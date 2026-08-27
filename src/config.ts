import * as vscode from 'vscode';

export const SECRET_KEY = 'azureAiChat.apiKey';
export const CONFIG_SECTION = 'azureAiChat';
const KEY_NOTICE_SHOWN = 'azureAiChat.plaintextKeyNoticeShown';

/** The shape of the `azureAiChat.connection` settings object. */
export interface ConnectionSettings {
  endpoint?: string;
  model?: string | string[];
  apiKey?: string;
  apiMode?: 'v1' | 'classic';
  apiVersion?: string;
}

export interface Settings {
  endpoint: string;
  /** Every configured deployment. Always at least one entry when configured. */
  models: string[];
  /** The first model — what the sidebar chat uses. */
  deployment: string;
  /** Key read from settings.json, if the user chose to put it there. */
  inlineApiKey: string;
  apiMode: 'v1' | 'classic';
  apiVersion: string;
  temperature: number;
  maxTokens: number;
  useMaxCompletionTokens: boolean;
  maxToolIterations: number;
  autoApproveEdits: boolean;
  includeActiveFile: boolean;
  maxFileBytes: number;
  excludeGlobs: string[];
  systemPrompt: string;
  /** Explicit path to bash.exe; empty means auto-detect. */
  bashPath: string;
  /** Ask before every command, including read-only ones. */
  requireApprovalForAll: boolean;
  defaultCommandTimeoutSeconds: number;
  /** Reasoning effort used when the composer selector is left on Default. */
  defaultReasoningEffort: '' | 'minimal' | 'low' | 'medium' | 'high';
  saveSessionHistory: boolean;
  saveConversations: boolean;
}

function toModelList(model: string | string[] | undefined): string[] {
  if (Array.isArray(model)) {
    return model.map((m) => String(m).trim()).filter(Boolean);
  }
  const one = String(model ?? '').trim();
  return one ? [one] : [];
}

export function getSettings(): Settings {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const conn = c.get<ConnectionSettings>('connection') ?? {};

  // Fall back to the pre-0.2 flat settings so an existing configuration keeps
  // working after upgrading.
  const endpoint = (
    conn.endpoint?.trim() ||
    c.get<string>('endpoint')?.trim() ||
    ''
  ).replace(/\/+$/, '');

  const models = toModelList(conn.model);
  if (models.length === 0) {
    const legacy = c.get<string>('deployment')?.trim();
    if (legacy) {
      models.push(legacy);
    }
  }

  return {
    endpoint,
    models,
    deployment: models[0] ?? '',
    inlineApiKey: (conn.apiKey ?? '').trim(),
    apiMode: conn.apiMode ?? c.get<'v1' | 'classic'>('apiMode') ?? 'v1',
    apiVersion: (
      conn.apiVersion ||
      c.get<string>('apiVersion') ||
      '2024-10-21'
    ).trim(),
    temperature: c.get<number>('temperature') ?? 0.2,
    maxTokens: c.get<number>('maxTokens') ?? 8000,
    useMaxCompletionTokens: c.get<boolean>('useMaxCompletionTokens') ?? false,
    maxToolIterations: c.get<number>('maxToolIterations') ?? 12,
    autoApproveEdits: c.get<boolean>('autoApproveEdits') ?? false,
    includeActiveFile: c.get<boolean>('includeActiveFile') ?? true,
    maxFileBytes: c.get<number>('maxFileBytes') ?? 200000,
    excludeGlobs: c.get<string[]>('excludeGlobs') ?? [],
    systemPrompt: c.get<string>('systemPrompt') ?? '',
    bashPath: (c.get<string>('shell.bashPath') ?? '').trim(),
    requireApprovalForAll: c.get<boolean>('shell.requireApprovalForAll') ?? false,
    defaultCommandTimeoutSeconds:
      c.get<number>('shell.timeoutSeconds') ?? 120,
    defaultReasoningEffort:
      (c.get<'' | 'minimal' | 'low' | 'medium' | 'high'>('reasoningEffort') ?? ''),
    saveSessionHistory: c.get<boolean>('saveSessionHistory') ?? true,
    saveConversations: c.get<boolean>('saveConversations') ?? true
  };
}

export function isConfigured(s: Settings): boolean {
  return Boolean(s.endpoint && s.deployment);
}

/** Builds the chat completions URL for a specific deployment. */
export function chatCompletionsUrl(s: Settings, model?: string): string {
  const deployment = model ?? s.deployment;
  if (!s.endpoint) {
    throw new Error(
      'No Azure OpenAI endpoint configured. Set "azureAiChat.connection" → endpoint in Settings.'
    );
  }
  if (!deployment) {
    throw new Error(
      'No Azure OpenAI model configured. Set "azureAiChat.connection" → model to your deployment name.'
    );
  }
  if (s.apiMode === 'v1') {
    return `${s.endpoint}/openai/v1/chat/completions`;
  }
  return `${s.endpoint}/openai/deployments/${encodeURIComponent(
    deployment
  )}/chat/completions?api-version=${encodeURIComponent(s.apiVersion)}`;
}

/**
 * Resolves the API key. A key written into settings.json wins, because that is
 * the user explicitly choosing where it lives; otherwise SecretStorage is used.
 */
export async function getApiKey(
  ctx: vscode.ExtensionContext,
  settings?: Settings
): Promise<string | undefined> {
  const s = settings ?? getSettings();
  if (s.inlineApiKey) {
    return s.inlineApiKey;
  }
  return ctx.secrets.get(SECRET_KEY);
}

export async function promptForApiKey(
  ctx: vscode.ExtensionContext
): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: 'Azure OpenAI API Key',
    prompt:
      'Paste your Azure OpenAI key. It is stored in VS Code SecretStorage, not in settings.json.',
    password: true,
    ignoreFocusOut: true
  });
  if (key && key.trim()) {
    await ctx.secrets.store(SECRET_KEY, key.trim());
    vscode.window.showInformationMessage('Azure AI Chat: API key saved.');
    return key.trim();
  }
  return undefined;
}

/**
 * Moves a key out of settings.json into SecretStorage. Offered once, because a
 * key in settings.json is world-readable, travels with Settings Sync, and gets
 * committed by accident when it lives in a workspace .vscode folder.
 */
export async function offerToSecureInlineKey(
  ctx: vscode.ExtensionContext
): Promise<void> {
  const s = getSettings();
  if (!s.inlineApiKey || ctx.globalState.get<boolean>(KEY_NOTICE_SHOWN)) {
    return;
  }

  const move = 'Move to Secret Storage';
  const keep = 'Keep it in settings';
  const choice = await vscode.window.showWarningMessage(
    'Azure AI Chat: your API key is stored in settings.json as plain text. It will sync with Settings Sync, and will be committed to git if it is in a workspace .vscode folder.',
    move,
    keep
  );

  if (choice === move) {
    await moveInlineKeyToSecretStorage(ctx);
  } else if (choice === keep) {
    await ctx.globalState.update(KEY_NOTICE_SHOWN, true);
  }
}

export async function moveInlineKeyToSecretStorage(
  ctx: vscode.ExtensionContext
): Promise<boolean> {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const inspected = c.inspect<ConnectionSettings>('connection');
  const s = getSettings();
  if (!s.inlineApiKey) {
    vscode.window.showInformationMessage(
      'Azure AI Chat: no API key found in settings.json.'
    );
    return false;
  }

  await ctx.secrets.store(SECRET_KEY, s.inlineApiKey);

  // Strip apiKey from whichever scope actually defines it.
  const scopes: Array<[ConnectionSettings | undefined, vscode.ConfigurationTarget]> = [
    [inspected?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
    [inspected?.workspaceValue, vscode.ConfigurationTarget.Workspace],
    [inspected?.globalValue, vscode.ConfigurationTarget.Global]
  ];

  for (const [value, target] of scopes) {
    if (value && typeof value.apiKey === 'string' && value.apiKey.trim()) {
      const { apiKey, ...rest } = value;
      void apiKey;
      await c.update('connection', rest, target);
    }
  }

  await ctx.globalState.update(KEY_NOTICE_SHOWN, true);
  vscode.window.showInformationMessage(
    'Azure AI Chat: API key moved to SecretStorage and removed from settings.json.'
  );
  return true;
}
