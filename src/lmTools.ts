import * as vscode from 'vscode';
import * as path from 'path';
import { getSettings } from './config';
import { classifyCommand } from './shell/policy';
import { findBash, formatResult, runCommand, toBashPath } from './shell/exec';
import { SessionRecorder, EntryKind } from './history';

/**
 * The same shell, git and validation capabilities the sidebar agent has, but
 * exposed as VS Code Language Model Tools so the native Chat view's agent mode
 * can call them too.
 *
 * The approval model differs by necessity: in the sidebar we own the UI and
 * render our own cards, whereas here VS Code owns confirmation. So
 * `prepareInvocation` asks for confirmation exactly when our policy says a
 * command mutates something, and stays silent when it only reads — which
 * produces the same behaviour through VS Code's own UI.
 */

const PREFIX = 'azureAiChat_';

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('No folder is open in VS Code.');
  }
  return folder.uri.fsPath;
}

function resolveCwd(rel?: string): string {
  const root = workspaceRoot();
  if (!rel || !rel.trim()) {
    return root;
  }
  const abs = path.resolve(root, rel.replace(/^[\\/]+/, ''));
  const relative = path.relative(root, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refused: cwd "${rel}" is outside the workspace.`);
  }
  return abs;
}

function textResult(text: string): unknown {
  const V = vscode as any;
  return new V.LanguageModelToolResult([new V.LanguageModelTextPart(text)]);
}

function markdown(text: string): unknown {
  const V = vscode as any;
  return V.MarkdownString ? new V.MarkdownString(text) : text;
}

async function execute(
  command: string,
  cwd: string,
  timeoutMs: number,
  token: vscode.CancellationToken,
  recorder: SessionRecorder
): Promise<string> {
  const settings = getSettings();
  const verdict = classifyCommand(command);

  if (verdict.verdict === 'denied') {
    recorder.add('command', `${command} (refused: ${verdict.reason})`, null);
    return `REFUSED: not run because it ${verdict.reason}. This command is on the never-run list.`;
  }

  const bash = findBash(settings.bashPath);
  if (!bash) {
    return process.platform === 'win32'
      ? 'Git Bash was not found. Install Git for Windows, or set "azureAiChat.shell.bashPath".'
      : 'No POSIX shell was found. Set "azureAiChat.shell.bashPath".';
  }

  const result = await runCommand(command, {
    cwd,
    bashPath: bash,
    timeoutMs,
    token
  });
  recorder.add('command', command, result.exitCode);
  return formatResult(result);
}

// --- run_command ----------------------------------------------------------

interface RunCommandInput {
  command: string;
  cwd?: string;
  timeout_seconds?: number;
}

class RunCommandTool {
  constructor(private readonly recorder: SessionRecorder) {}

  prepareInvocation(options: { input: RunCommandInput }): unknown {
    const command = String(options.input?.command ?? '');
    const verdict = classifyCommand(command);

    if (verdict.verdict === 'auto' && !getSettings().requireApprovalForAll) {
      // Read-only: no confirmation, matching the sidebar's behaviour.
      return { invocationMessage: `Running \`${command}\`` };
    }

    return {
      invocationMessage: `Running \`${command}\``,
      confirmationMessages: {
        title: verdict.verdict === 'denied' ? 'Refused command' : 'Run this command?',
        message: markdown(
          verdict.verdict === 'denied'
            ? `\`${command}\`\n\nThis will not be run: it ${verdict.reason}.`
            : `\`\`\`\n${command}\n\`\`\`\n\nThis needs approval because it ${verdict.reason}.`
        )
      }
    };
  }

  async invoke(
    options: { input: RunCommandInput },
    token: vscode.CancellationToken
  ): Promise<unknown> {
    const input = options.input ?? ({} as RunCommandInput);
    const command = String(input.command ?? '').trim();
    if (!command) {
      return textResult('Error: command is required.');
    }

    let cwd: string;
    try {
      cwd = resolveCwd(input.cwd);
    } catch (e) {
      return textResult(`Error: ${(e as Error).message}`);
    }

    const seconds = Math.min(Math.max(Number(input.timeout_seconds) || 120, 1), 600);
    return textResult(
      await execute(command, cwd, seconds * 1000, token, this.recorder)
    );
  }
}

// --- git ------------------------------------------------------------------

class GitStatusTool {
  constructor(private readonly recorder: SessionRecorder) {}

  prepareInvocation(): unknown {
    return { invocationMessage: 'Checking git status' };
  }

  async invoke(_o: unknown, token: vscode.CancellationToken): Promise<unknown> {
    try {
      return textResult(
        await execute(
          'git status --short --branch',
          resolveCwd(),
          60_000,
          token,
          this.recorder
        )
      );
    } catch (e) {
      return textResult(`Error: ${(e as Error).message}`);
    }
  }
}

interface GitDiffInput {
  staged?: boolean;
  path?: string;
  stat_only?: boolean;
}

class GitDiffTool {
  constructor(private readonly recorder: SessionRecorder) {}

  prepareInvocation(): unknown {
    return { invocationMessage: 'Reading the working tree diff' };
  }

  async invoke(
    options: { input: GitDiffInput },
    token: vscode.CancellationToken
  ): Promise<unknown> {
    const input = options.input ?? {};
    const parts = ['git', 'diff'];
    if (input.staged) parts.push('--staged');
    if (input.stat_only) parts.push('--stat');
    parts.push('--no-color');
    if (input.path) {
      parts.push('--', `"${String(input.path).replace(/"/g, '')}"`);
    }
    try {
      return textResult(
        await execute(parts.join(' '), resolveCwd(), 60_000, token, this.recorder)
      );
    } catch (e) {
      return textResult(`Error: ${(e as Error).message}`);
    }
  }
}

// --- validation -----------------------------------------------------------

interface ValidationInput {
  kinds?: string[];
}

class RunValidationTool {
  constructor(private readonly recorder: SessionRecorder) {}

  prepareInvocation(): unknown {
    return {
      invocationMessage: "Running the project's checks"
    };
  }

  async invoke(
    options: { input: ValidationInput },
    token: vscode.CancellationToken
  ): Promise<unknown> {
    let root: string;
    try {
      root = workspaceRoot();
    } catch (e) {
      return textResult(`Error: ${(e as Error).message}`);
    }

    const checks = await discoverChecks();
    const wanted = Array.isArray(options.input?.kinds)
      ? options.input.kinds.map(String)
      : [];
    const selected = wanted.length
      ? checks.filter((c) => wanted.includes(c.kind))
      : checks;

    if (selected.length === 0) {
      return textResult(
        checks.length === 0
          ? 'No validation scripts found in this workspace. Say so rather than claiming the project was validated.'
          : `None of the requested checks exist. Available: ${checks.map((c) => c.kind).join(', ')}.`
      );
    }

    const report: string[] = [];
    for (const check of selected) {
      if (token.isCancellationRequested) break;
      const output = await execute(
        check.command,
        root,
        300_000,
        token,
        this.recorder
      );
      const passed = /exit 0\b/.test(output.split('\n')[1] ?? '');
      this.recorder.add(
        'validation',
        `${check.kind} (${check.command}): ${passed ? 'passed' : 'FAILED'}`
      );
      report.push(`### ${check.kind} — ${check.command}\n${output}`);
    }

    return textResult(
      [
        'Validation results. Report only these outcomes; do not claim any check passed that is not shown here.',
        '',
        ...report
      ].join('\n')
    );
  }
}

interface Check {
  kind: 'typecheck' | 'lint' | 'test' | 'build';
  command: string;
}

async function discoverChecks(): Promise<Check[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return [];
  const root = folder.uri;
  const checks: Check[] = [];

  const readJson = async (name: string): Promise<any | undefined> => {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(root, name)
      );
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return undefined;
    }
  };

  const exists = async (name: string): Promise<boolean> => {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, name));
      return true;
    } catch {
      return false;
    }
  };

  const pkg = await readJson('package.json');
  if (pkg?.scripts && typeof pkg.scripts === 'object') {
    const scripts = pkg.scripts as Record<string, string>;
    const pick = (kind: Check['kind'], candidates: string[]) => {
      const found = candidates.find((c) => typeof scripts[c] === 'string');
      if (found) checks.push({ kind, command: `npm run ${found}` });
    };
    pick('typecheck', ['type-check', 'typecheck', 'check-types', 'tsc']);
    pick('lint', ['lint', 'eslint']);
    if (typeof scripts.test === 'string' && !/no test specified/i.test(scripts.test)) {
      checks.push({ kind: 'test', command: 'npm test' });
    }
    pick('build', ['build', 'compile']);
  }

  if (await exists('pyproject.toml')) {
    if (!checks.some((c) => c.kind === 'test')) {
      checks.push({ kind: 'test', command: 'python -m pytest -q' });
    }
  }
  if (!checks.some((c) => c.kind === 'typecheck') && (await exists('tsconfig.json'))) {
    checks.push({ kind: 'typecheck', command: 'npx tsc --noEmit' });
  }

  return checks;
}

// --- session recording ----------------------------------------------------

interface RecordInput {
  kind?: string;
  text?: string;
}

class RecordSessionTool {
  constructor(private readonly recorder: SessionRecorder) {}

  prepareInvocation(options: { input: RecordInput }): unknown {
    return {
      invocationMessage: `Recording ${String(options.input?.kind ?? 'note')}`
    };
  }

  async invoke(options: { input: RecordInput }): Promise<unknown> {
    const kind = String(options.input?.kind ?? 'note');
    const text = String(options.input?.text ?? '').trim();
    const allowed = ['requirement', 'decision', 'file-changed', 'bug', 'fix', 'todo', 'note'];
    if (!text) {
      return textResult('Error: text is required.');
    }
    if (!allowed.includes(kind)) {
      return textResult(`Error: kind must be one of ${allowed.join(', ')}.`);
    }
    this.recorder.add(kind as EntryKind, text);
    return textResult(`Recorded (${kind}) in the session report.`);
  }
}

// --- registration ---------------------------------------------------------

/**
 * Registers the tools if this VS Code build has the API. Returns an empty list
 * on older builds so the extension still activates.
 */
export function registerLanguageModelTools(
  recorder: SessionRecorder
): vscode.Disposable[] {
  const lm = (vscode as any).lm;
  if (!lm || typeof lm.registerTool !== 'function') {
    return [];
  }

  const entries: Array<[string, unknown]> = [
    [`${PREFIX}runCommand`, new RunCommandTool(recorder)],
    [`${PREFIX}gitStatus`, new GitStatusTool(recorder)],
    [`${PREFIX}gitDiff`, new GitDiffTool(recorder)],
    [`${PREFIX}runValidation`, new RunValidationTool(recorder)],
    [`${PREFIX}recordSession`, new RecordSessionTool(recorder)]
  ];

  const disposables: vscode.Disposable[] = [];
  for (const [name, tool] of entries) {
    try {
      disposables.push(lm.registerTool(name, tool));
    } catch (err) {
      console.warn(`Azure AI Chat: could not register tool ${name}`, err);
    }
  }
  return disposables;
}

export { toBashPath };
