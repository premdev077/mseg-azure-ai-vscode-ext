import * as vscode from 'vscode';
import { ChatMessage, ContentPart } from './azureClient';
import { getSettings } from './config';

/**
 * Persistent conversations.
 *
 * These live under the extension's `globalStorageUri`, which VS Code places in
 * the user profile on the machine VS Code is running on
 * (`%APPDATA%\Code\User\globalStorage\...` on Windows). That is deliberately
 * not the temp folder the session *report* uses: a transcript you can reopen
 * and continue should not disappear when Windows cleans %TEMP%.
 *
 * Unlike the report, transcripts are stored verbatim. Redacting them would
 * corrupt the very content a continuation depends on. What is stripped is
 * image data, which would otherwise put megabytes of base64 on disk per turn.
 */

export interface StoredConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  model?: string;
  messages: ChatMessage[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  model?: string;
  messageCount: number;
}

const DIR = 'conversations';
const MAX_CONVERSATIONS = 200;

export class ConversationStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /** The folder transcripts are written to, for showing the user. */
  get folder(): vscode.Uri {
    return vscode.Uri.joinPath(this.ctx.globalStorageUri, DIR);
  }

  private fileFor(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.folder, `${safeId(id)}.json`);
  }

  async save(conversation: StoredConversation): Promise<void> {
    if (!getSettings().saveConversations) {
      return;
    }
    if (conversation.messages.filter((m) => m.role === 'user').length === 0) {
      return; // nothing worth keeping yet
    }
    try {
      await vscode.workspace.fs.createDirectory(this.folder);
      const payload: StoredConversation = {
        ...conversation,
        updatedAt: new Date().toISOString(),
        messages: conversation.messages.map(stripHeavyContent)
      };
      await vscode.workspace.fs.writeFile(
        this.fileFor(conversation.id),
        new TextEncoder().encode(JSON.stringify(payload, null, 2))
      );
      void this.prune();
    } catch (err) {
      // History is a convenience. A failure to write must never interrupt the
      // conversation itself.
      console.warn('Azure AI Chat: could not save conversation', err);
    }
  }

  async list(): Promise<ConversationSummary[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.folder);
    } catch {
      return [];
    }

    const out: ConversationSummary[] = [];
    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory || !name.endsWith('.json')) {
        continue;
      }
      const record = await this.readFile(
        vscode.Uri.joinPath(this.folder, name)
      );
      if (record) {
        out.push({
          id: record.id,
          title: record.title || '(untitled)',
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          workspace: record.workspace,
          model: record.model,
          messageCount: record.messages.filter(
            (m) => m.role === 'user' || m.role === 'assistant'
          ).length
        });
      }
    }

    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  }

  async load(id: string): Promise<StoredConversation | undefined> {
    return this.readFile(this.fileFor(id));
  }

  async delete(id: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.fileFor(id));
    } catch {
      /* already gone */
    }
  }

  async deleteAll(): Promise<number> {
    const items = await this.list();
    for (const item of items) {
      await this.delete(item.id);
    }
    return items.length;
  }

  private async readFile(
    uri: vscode.Uri
  ): Promise<StoredConversation | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(
        new TextDecoder().decode(bytes)
      ) as StoredConversation;
      if (parsed && typeof parsed.id === 'string' && Array.isArray(parsed.messages)) {
        return parsed;
      }
    } catch {
      /* skip unreadable conversation */
    }
    return undefined;
  }

  /** Keeps the folder from growing without bound. */
  private async prune(): Promise<void> {
    const items = await this.list();
    if (items.length <= MAX_CONVERSATIONS) {
      return;
    }
    for (const item of items.slice(MAX_CONVERSATIONS)) {
      await this.delete(item.id);
    }
  }
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

/**
 * Replaces base64 image payloads with a note. The transcript stays readable
 * and continuable; the image itself is not carried forward, which is stated
 * plainly in the placeholder so the model does not pretend to still see it.
 */
function stripHeavyContent(message: ChatMessage): ChatMessage {
  if (!Array.isArray(message.content)) {
    return message;
  }
  const parts: ContentPart[] = message.content.map((part) =>
    part.type === 'image_url'
      ? {
          type: 'text' as const,
          text: '[An image was attached in this turn. It is not part of the reloaded history — ask the user to attach it again if you need to see it.]'
        }
      : part
  );
  return { ...message, content: parts };
}

/** A short label for the history list, taken from the first thing asked. */
export function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) {
    return 'New conversation';
  }

  let text = '';
  if (typeof firstUser.content === 'string') {
    text = firstUser.content;
  } else if (Array.isArray(firstUser.content)) {
    text = firstUser.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join(' ');
  }

  // Drop any attached-context block so the title is the actual question.
  text = text
    .replace(/\[Active editor[\s\S]*?```[\s\S]*?```/g, '')
    .replace(/\[Current selection[\s\S]*?```[\s\S]*?```/g, '')
    .replace(/\[Attached file:[^\]]*\][\s\S]*?```[\s\S]*?```/g, '')
    .replace(/\[Attached image:[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return text ? text.slice(0, 90) : 'New conversation';
}

/**
 * Flattens a stored transcript into what the webview needs to redraw it.
 * Tool traffic collapses into one compact row per call — enough to see what
 * happened without replaying every byte of output.
 */
export interface RenderedTurn {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  /** Tool name, for tool rows. */
  tool?: string;
  detail?: string;
}

export function renderTranscript(messages: ChatMessage[]): RenderedTurn[] {
  const turns: RenderedTurn[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      continue;
    }

    if (message.role === 'tool') {
      continue; // summarised on the assistant row that requested it
    }

    const text = contentToText(message.content);

    if (message.role === 'assistant') {
      if (text.trim()) {
        turns.push({ role: 'assistant', text });
      }
      for (const call of message.tool_calls ?? []) {
        turns.push({
          role: 'tool',
          text: '',
          tool: call.function.name,
          detail: summariseArgs(call.function.arguments)
        });
      }
      continue;
    }

    if (text.trim()) {
      turns.push({ role: 'user', text: stripContextBlocks(text) });
    }
  }

  return turns;
}

function contentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((p) => (p.type === 'text' ? p.text : '[image]'))
      .join('\n');
  }
  return '';
}

function stripContextBlocks(text: string): string {
  return text
    .replace(/\[Active editor[\s\S]*?```[\s\S]*?```\n?/g, '')
    .replace(/\[Current selection[\s\S]*?```[\s\S]*?```\n?/g, '')
    .trim();
}

function summariseArgs(raw: string): string {
  try {
    const o = JSON.parse(raw || '{}');
    if (typeof o.command === 'string') return o.command;
    if (typeof o.path === 'string') return o.path;
    if (typeof o.pattern === 'string') return `/${o.pattern}/`;
    if (typeof o.glob === 'string') return o.glob;
    return '';
  } catch {
    return '';
  }
}
