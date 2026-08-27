import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getSettings } from './config';

export type EntryKind =
  | 'requirement'
  | 'decision'
  | 'file-changed'
  | 'bug'
  | 'fix'
  | 'todo'
  | 'note'
  | 'command'
  | 'validation';

export interface SessionEntry {
  at: string;
  kind: EntryKind;
  text: string;
  /** Present on command entries. */
  exitCode?: number | null;
}

export interface SessionRecord {
  id: string;
  startedAt: string;
  updatedAt: string;
  workspace: string;
  workspacePath: string;
  task: string;
  entries: SessionEntry[];
}

/**
 * Where session context lives. On Windows `os.tmpdir()` is
 * %LOCALAPPDATA%\Temp, which is the location the engineering brief specifies;
 * elsewhere it degrades to the platform temp directory.
 */
export function historyDir(): string {
  return path.join(os.tmpdir(), 'merw-azure-ai', 'conversations');
}

// --- redaction ------------------------------------------------------------

const SECRET_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // KEY=value / "apiKey": "value" style assignments
  {
    re: /\b([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|CONNECTION_?STRING)[A-Za-z0-9_]*)\s*[:=]\s*["']?([^\s"',;]{4,})["']?/gi,
    replace: '$1=<REDACTED>'
  },
  // Bearer tokens
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, replace: 'Bearer <REDACTED>' },
  // Azure OpenAI keys are 32+ hex chars
  { re: /\b[a-f0-9]{32,}\b/gi, replace: '<REDACTED>' },
  // JWTs
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: '<REDACTED>' },
  // URLs carrying credentials
  { re: /\b([a-z]+:\/\/)[^/\s:@]+:[^/\s@]+@/gi, replace: '$1<REDACTED>@' },
  // Connection strings
  { re: /\b(AccountKey|SharedAccessSignature|sig)=[^;\s&]+/gi, replace: '$1=<REDACTED>' },
  // Private key blocks
  {
    re: /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
    replace: '<REDACTED PRIVATE KEY>'
  }
];

/**
 * Strips anything that looks like a credential before it is written to disk.
 * Deliberately over-eager: a redacted note is recoverable, a leaked key is not.
 */
export function redact(text: string): string {
  let out = text;
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

// --- recorder -------------------------------------------------------------

export class SessionRecorder {
  private record: SessionRecord;
  private dirty = false;
  private writeTimer: NodeJS.Timeout | undefined;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(sessionId?: string) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    this.record = {
      id: sessionId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspace: folder?.name ?? '(no folder)',
      workspacePath: folder?.uri.fsPath ?? '',
      task: '',
      entries: []
    };
  }

  get current(): SessionRecord {
    return this.record;
  }

  setTask(task: string): void {
    const clean = redact(task).trim();
    if (!this.record.task && clean) {
      this.record.task = clean.slice(0, 300);
      this.touch();
    }
  }

  add(kind: EntryKind, text: string, exitCode?: number | null): void {
    const clean = redact(text).trim();
    if (!clean) return;
    this.record.entries.push({
      at: new Date().toISOString(),
      kind,
      text: clean.slice(0, 2000),
      ...(exitCode === undefined ? {} : { exitCode })
    });
    if (this.record.entries.length > 500) {
      this.record.entries.splice(0, this.record.entries.length - 500);
    }
    this.touch();
  }

  reset(): void {
    this.flushNow();
    this.record = new SessionRecorder().record;
    this.onDidChangeEmitter.fire();
  }

  private touch(): void {
    this.record.updatedAt = new Date().toISOString();
    this.dirty = true;
    this.onDidChangeEmitter.fire();
    // Batch writes: a busy agent turn produces many entries a second.
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => {
        this.writeTimer = undefined;
        this.flushNow();
      }, 1500);
    }
  }

  flushNow(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      if (!getSettings().saveSessionHistory) {
        return;
      }
    } catch {
      // Settings unavailable (during disposal); fall through and write.
    }
    try {
      const dir = historyDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${this.record.id}.json`),
        JSON.stringify(this.record, null, 2),
        'utf8'
      );
      fs.writeFileSync(
        path.join(dir, `${this.record.id}.md`),
        renderMarkdown(this.record),
        'utf8'
      );
    } catch {
      // The history folder is a convenience, never a dependency: a failure to
      // write it must not interrupt the conversation.
    }
  }

  dispose(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    this.flushNow();
    this.onDidChangeEmitter.dispose();
  }
}

// --- reading past sessions ------------------------------------------------

export function listSessions(limit = 30): SessionRecord[] {
  const dir = historyDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n: string) => n.endsWith('.json'));
  } catch {
    return [];
  }

  const records: SessionRecord[] = [];
  for (const name of names) {
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      const parsed = JSON.parse(raw) as SessionRecord;
      if (parsed && typeof parsed.id === 'string') {
        records.push(parsed);
      }
    } catch {
      /* skip unreadable session */
    }
  }

  records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return records.slice(0, limit);
}

/** A compact briefing of a past session, for injecting into a new one. */
export function summariseForResume(record: SessionRecord): string {
  const byKind = (kind: EntryKind) =>
    record.entries.filter((e) => e.kind === kind).map((e) => e.text);

  const section = (title: string, items: string[]) =>
    items.length ? `${title}:\n${items.map((i) => `- ${i}`).join('\n')}` : '';

  return [
    `[Context recovered from a previous session on ${record.workspace}, last updated ${record.updatedAt}]`,
    record.task ? `Task: ${record.task}` : '',
    section('Requirements', byKind('requirement')),
    section('Decisions', byKind('decision')),
    section('Files changed', unique(byKind('file-changed'))),
    section('Bugs found', byKind('bug')),
    section('Fixes applied', byKind('fix')),
    section('Outstanding', byKind('todo')),
    '',
    'This is context, not truth. Verify anything important against the current code before relying on it.'
  ]
    .filter(Boolean)
    .join('\n\n');
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

export function renderMarkdown(record: SessionRecord): string {
  const lines: string[] = [
    `# Session report — ${record.workspace}`,
    '',
    `- **Session**: \`${record.id}\``,
    `- **Started**: ${record.startedAt}`,
    `- **Last updated**: ${record.updatedAt}`,
    ...(record.workspacePath ? [`- **Workspace**: \`${record.workspacePath}\``] : []),
    ''
  ];

  if (record.task) {
    lines.push('## Task', '', record.task, '');
  }

  const group = (title: string, kinds: EntryKind[], render: (e: SessionEntry) => string) => {
    const items = record.entries.filter((e) => kinds.includes(e.kind));
    if (!items.length) return;
    lines.push(`## ${title}`, '');
    for (const e of items) {
      lines.push(render(e));
    }
    lines.push('');
  };

  group('Requirements', ['requirement'], (e) => `- ${e.text}`);
  group('Technical decisions', ['decision'], (e) => `- ${e.text}`);
  group('Files changed', ['file-changed'], (e) => `- ${e.text}`);
  group('Bugs and fixes', ['bug', 'fix'], (e) => `- **${e.kind}**: ${e.text}`);
  group(
    'Commands run',
    ['command'],
    (e) =>
      `- \`${e.text}\` — ${
        e.exitCode === null || e.exitCode === undefined
          ? 'did not complete'
          : `exit ${e.exitCode}`
      }`
  );
  group('Validation', ['validation'], (e) => `- ${e.text}`);
  group('Outstanding', ['todo'], (e) => `- [ ] ${e.text}`);
  group('Notes', ['note'], (e) => `- ${e.text}`);

  if (record.entries.length === 0) {
    lines.push('_Nothing recorded yet._');
  }

  // Only drop the placeholder produced by an absent workspacePath; internal
  // blank lines are structural and Markdown needs them.
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
