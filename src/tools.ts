import * as vscode from 'vscode';
import * as path from 'path';
import { Settings } from './config';
import { ToolSpec } from './azureClient';
import { EditReviewManager, PendingEdit, diffStat } from './editReview';
import { CommandApprovalManager } from './commandApproval';
import { classifyCommand } from './shell/policy';
import { findBash, formatResult, runCommand, toBashPath } from './shell/exec';
import { SessionRecorder } from './history';

export interface ToolContext {
  settings: Settings;
  edits: EditReviewManager;
  commands: CommandApprovalManager;
  recorder: SessionRecorder;
  /** Notifies the panel that a command is awaiting approval. */
  onCommandProposed: (info: {
    id: string;
    command: string;
    cwd: string;
    reason: string;
    autoRun: boolean;
  }) => void;
  /** Reports a finished command so the panel can show its exit code. */
  onCommandFinished: (info: {
    id: string;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
    output: string;
  }) => void;
  /** Notifies the panel that an edit is awaiting review. */
  onEditProposed: (info: {
    id: string;
    relPath: string;
    added: number;
    removed: number;
    isNewFile: boolean;
  }) => void;
  token: vscode.CancellationToken;
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a UTF-8 text file from the workspace. Always read a file before proposing edits to it, so your replacement content is based on what is actually there.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative path, e.g. "src/app.ts".'
          },
          start_line: {
            type: 'number',
            description: 'Optional 1-based first line to return.'
          },
          end_line: {
            type: 'number',
            description: 'Optional 1-based last line to return.'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'List files in the workspace matching a glob. Use this to orient yourself before reading or searching.',
      parameters: {
        type: 'object',
        properties: {
          glob: {
            type: 'string',
            description:
              'Glob relative to the workspace root, e.g. "src/**/*.ts". Defaults to "**/*".'
          },
          max_results: {
            type: 'number',
            description: 'Maximum paths to return. Defaults to 200.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_workspace',
      description:
        'Search file contents across the workspace for a regular expression, returning matching lines with their file and line number.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'JavaScript regular expression source.'
          },
          glob: {
            type: 'string',
            description: 'Optional glob to restrict which files are searched.'
          },
          max_results: {
            type: 'number',
            description: 'Maximum matching lines to return. Defaults to 60.'
          }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Propose the full new contents of a file. The user sees a diff and accepts or rejects it; the tool result tells you which happened. Always send the complete file, never a fragment or a placeholder comment.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Workspace-relative path. May be a file that does not exist yet.'
          },
          content: {
            type: 'string',
            description: 'The complete new contents of the file.'
          },
          summary: {
            type: 'string',
            description: 'One short line describing what this edit does.'
          }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command in the workspace using Git Bash (or the system shell on macOS/Linux). Read-only commands and the project\'s own lint/type-check/test/build scripts run immediately; anything that changes files, packages, the git repository or the machine waits for the user to approve it. stdin is closed, so never run an interactive command. Use this to inspect versions, search, run git, and validate your work — do not ask the user to run commands themselves.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The command line to run, e.g. "git status" or "npm run type-check".'
          },
          cwd: {
            type: 'string',
            description:
              'Optional workspace-relative directory to run in. Defaults to the workspace root.'
          },
          timeout_seconds: {
            type: 'number',
            description: 'Optional timeout. Defaults to 120, maximum 600.'
          },
          explanation: {
            type: 'string',
            description:
              'One short line saying why you are running this. Shown to the user on the approval card.'
          }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description:
        'Show the working tree status and the current branch. Run this before making significant changes so you know what uncommitted work already exists.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description:
        'Show the diff of the working tree, so you can review exactly what changed. Use it after implementing something.',
      parameters: {
        type: 'object',
        properties: {
          staged: {
            type: 'boolean',
            description: 'Diff the staged changes instead of the working tree.'
          },
          path: {
            type: 'string',
            description: 'Optional workspace-relative path to limit the diff to.'
          },
          stat_only: {
            type: 'boolean',
            description: 'Return only the summary of files changed.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_validation',
      description:
        "Discover and run the project's real validation scripts (type-check, lint, test, build) by reading package.json, pyproject.toml or requirements.txt. Prefer this over guessing command names. Call it after making changes, and report only what actually ran.",
      parameters: {
        type: 'object',
        properties: {
          kinds: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['typecheck', 'lint', 'test', 'build']
            },
            description: 'Which checks to run. Defaults to everything available.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'record_session',
      description:
        'Record durable technical context for this session — the requirement, a decision, a file you changed, a bug found or fixed, or a next step. It is written to the local session log so a later session can pick up where this one stopped, and it feeds the session report. Never record secrets.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['requirement', 'decision', 'file-changed', 'bug', 'fix', 'todo', 'note'],
            description: 'What sort of entry this is.'
          },
          text: { type: 'string', description: 'One or two concise sentences.' }
        },
        required: ['kind', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_diagnostics',
      description:
        'Return current errors and warnings (from language servers and linters) for a file, or for the whole workspace if no path is given. Use this to check your work after an edit is accepted.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Optional workspace-relative path.'
          }
        }
      }
    }
  }
];

function workspaceFolders(): vscode.WorkspaceFolder[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error(
      'No folder is open in VS Code, so workspace tools are unavailable. Open a folder and try again.'
    );
  }
  return folders;
}

const multiRoot = (): boolean => workspaceFolders().length > 1;

/**
 * The path a tool reports back to the model. In a multi-root workspace it is
 * prefixed with the folder name, so the path the model reads is the same path
 * resolveInWorkspace() can turn back into the right file.
 */
function displayPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, multiRoot());
}

/**
 * A glob for findFiles. With one folder open it is anchored to that folder;
 * with several it is left relative so every folder is searched.
 */
function searchPattern(glob: string): vscode.RelativePattern | string {
  const folders = workspaceFolders();
  return folders.length === 1
    ? new vscode.RelativePattern(folders[0], glob)
    : glob;
}

/** Resolves a model-supplied path and refuses anything outside the workspace. */
function resolveInWorkspace(relPath: string): {
  uri: vscode.Uri;
  relPath: string;
} {
  const folders = workspaceFolders();
  const cleaned = String(relPath).replace(/^[\\/]+/, '');

  // In a multi-root workspace, an initial segment naming a folder selects it.
  let root = folders[0];
  let rest = cleaned;
  if (folders.length > 1) {
    const slash = cleaned.indexOf('/');
    const head = slash === -1 ? cleaned : cleaned.slice(0, slash);
    const named = folders.find((f) => f.name === head);
    if (named) {
      root = named;
      rest = slash === -1 ? '' : cleaned.slice(slash + 1);
    }
  }

  const rootPath = root.uri.fsPath;
  const abs = path.resolve(rootPath, rest);
  const rel = path.relative(rootPath, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Refused: "${relPath}" resolves outside the open workspace folder(s).`
    );
  }
  return { uri: vscode.Uri.file(abs), relPath: displayPath(vscode.Uri.file(abs)) };
}

function excludePattern(settings: Settings): string | undefined {
  if (!settings.excludeGlobs.length) {
    return undefined;
  }
  return `{${settings.excludeGlobs.join(',')}}`;
}

async function readText(uri: vscode.Uri, maxBytes: number): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const truncated = bytes.byteLength > maxBytes;
  const slice = truncated ? bytes.slice(0, maxBytes) : bytes;
  const text = new TextDecoder('utf-8').decode(slice);
  return truncated
    ? `${text}\n\n[... truncated: file is ${bytes.byteLength} bytes, showing first ${maxBytes} ...]`
    : text;
}

export async function runTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext
): Promise<string> {
  let args: any;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return `Error: arguments for ${name} were not valid JSON. Received: ${rawArgs.slice(
      0,
      400
    )}`;
  }

  try {
    switch (name) {
      case 'read_file':
        return await toolReadFile(args, ctx);
      case 'list_files':
        return await toolListFiles(args, ctx);
      case 'search_workspace':
        return await toolSearch(args, ctx);
      case 'write_file':
        return await toolWriteFile(args, ctx);
      case 'run_command':
        return await toolRunCommand(args, ctx);
      case 'git_status':
        return await toolGit(['status', '--short', '--branch'], ctx);
      case 'git_diff':
        return await toolGitDiff(args, ctx);
      case 'run_validation':
        return await toolRunValidation(args, ctx);
      case 'record_session':
        return toolRecord(args, ctx);
      case 'get_diagnostics':
        return toolDiagnostics(args);
      default:
        return `Error: unknown tool "${name}".`;
    }
  } catch (err) {
    return `Error running ${name}: ${(err as Error).message}`;
  }
}

async function toolReadFile(args: any, ctx: ToolContext): Promise<string> {
  const { uri, relPath } = resolveInWorkspace(String(args.path ?? ''));
  let text: string;
  try {
    text = await readText(uri, ctx.settings.maxFileBytes);
  } catch {
    return `Error: could not read "${relPath}". It may not exist or may not be a text file.`;
  }

  const start = Number(args.start_line);
  const end = Number(args.end_line);
  if (Number.isFinite(start) || Number.isFinite(end)) {
    const lines = text.split(/\r?\n/);
    const from = Math.max(1, Number.isFinite(start) ? start : 1);
    const to = Math.min(lines.length, Number.isFinite(end) ? end : lines.length);
    const numbered = lines
      .slice(from - 1, to)
      .map((l, i) => `${from + i}\t${l}`)
      .join('\n');
    return `${relPath} (lines ${from}-${to} of ${lines.length}):\n${numbered}`;
  }

  const total = text.split(/\r?\n/).length;
  return `${relPath} (${total} lines):\n${text}`;
}

async function toolListFiles(args: any, ctx: ToolContext): Promise<string> {
  const glob = String(args.glob ?? '**/*');
  const max = Math.min(Number(args.max_results) || 200, 1000);
  const found = await vscode.workspace.findFiles(
    searchPattern(glob),
    excludePattern(ctx.settings),
    max
  );
  if (found.length === 0) {
    return `No files matched "${glob}".`;
  }
  const rel = found.map((u: vscode.Uri) => displayPath(u));
  rel.sort();
  return `${rel.length} file(s) matching "${glob}":\n${rel.join('\n')}`;
}

async function toolSearch(args: any, ctx: ToolContext): Promise<string> {
  const pattern = String(args.pattern ?? '');
  if (!pattern) {
    return 'Error: pattern is required.';
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch (e) {
    return `Error: invalid regular expression. ${(e as Error).message}`;
  }

  const max = Math.min(Number(args.max_results) || 60, 300);
  const files = await vscode.workspace.findFiles(
    searchPattern(String(args.glob ?? '**/*')),
    excludePattern(ctx.settings),
    2000
  );

  const hits: string[] = [];
  for (const uri of files) {
    if (ctx.token.isCancellationRequested || hits.length >= max) {
      break;
    }
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > ctx.settings.maxFileBytes) {
        continue;
      }
      text = new TextDecoder('utf-8').decode(bytes);
    } catch {
      continue;
    }
    if (text.indexOf('\u0000') !== -1) {
      continue; // looks binary
    }
    const rel = displayPath(uri);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && hits.length < max; i++) {
      if (re.test(lines[i])) {
        hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
      }
    }
  }

  return hits.length
    ? `${hits.length} match(es) for /${pattern}/:\n${hits.join('\n')}`
    : `No matches for /${pattern}/.`;
}

async function toolWriteFile(args: any, ctx: ToolContext): Promise<string> {
  const { uri, relPath } = resolveInWorkspace(String(args.path ?? ''));
  const proposed = String(args.content ?? '');

  let original = '';
  let isNewFile = false;
  try {
    original = await readText(uri, 10_000_000);
  } catch {
    isNewFile = true;
  }

  if (!isNewFile && original === proposed) {
    return `No change: the proposed content of ${relPath} is identical to what is already on disk.`;
  }

  const stat = diffStat(original, proposed);

  if (ctx.settings.autoApproveEdits) {
    if (isNewFile) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    }
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(proposed));
    ctx.onEditProposed({
      id: 'auto',
      relPath,
      added: stat.added,
      removed: stat.removed,
      isNewFile
    });
    ctx.recorder.add('file-changed', `${relPath} (+${stat.added} −${stat.removed}, auto-applied)`);
    return `Applied automatically (auto-approve is on): ${relPath}, +${stat.added} −${stat.removed}.`;
  }

  const id = ctx.edits.nextId();
  const decision = await new Promise<'accepted' | 'rejected'>((resolve) => {
    const edit: PendingEdit = {
      id,
      uri,
      relPath,
      originalText: original,
      proposedText: proposed,
      isNewFile,
      resolve
    };
    ctx.edits.register(edit);
    void ctx.edits.showDiff(edit);
    ctx.onEditProposed({
      id,
      relPath,
      added: stat.added,
      removed: stat.removed,
      isNewFile
    });

    if (ctx.token.isCancellationRequested) {
      ctx.edits.reject(id);
      return;
    }
    ctx.token.onCancellationRequested(() => ctx.edits.reject(id));
  });

  if (decision === 'accepted') {
    ctx.recorder.add('file-changed', `${relPath} (+${stat.added} −${stat.removed})`);
  }

  return decision === 'accepted'
    ? `The user accepted the edit to ${relPath} (+${stat.added} −${stat.removed}). It is now written to disk.`
    : `The user REJECTED the edit to ${relPath}. The file is unchanged. Do not retry the same edit — ask what they want different, or stop.`;
}


// ---------------------------------------------------------------------------
// Shell-backed tools
// ---------------------------------------------------------------------------

function resolveCwd(rel: string | undefined): string {
  const root = workspaceFolders()[0].uri.fsPath;
  if (!rel || !String(rel).trim()) {
    return root;
  }
  const abs = path.resolve(root, String(rel).replace(/^[\\/]+/, ''));
  const relative = path.relative(root, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refused: cwd "${rel}" is outside the workspace.`);
  }
  return abs;
}

function resolveBash(ctx: ToolContext): string {
  const bash = findBash(ctx.settings.bashPath);
  if (!bash) {
    throw new Error(
      process.platform === 'win32'
        ? 'Git Bash was not found. Install Git for Windows, or set "azureAiChat.shell.bashPath" to your bash.exe.'
        : 'No POSIX shell was found. Set "azureAiChat.shell.bashPath".'
    );
  }
  return bash;
}

/**
 * Runs a command, gating it on the policy. Auto-runnable commands execute
 * immediately; anything mutating waits for the user's click, and the tool
 * result tells the model which happened so it never assumes a command ran.
 */
async function executeGated(
  command: string,
  cwd: string,
  ctx: ToolContext,
  timeoutMs: number
): Promise<string> {
  const classification = classifyCommand(command);

  if (classification.verdict === 'denied') {
    ctx.recorder.add('command', `${command} (refused: ${classification.reason})`, null);
    return `REFUSED: this command was not run because it ${classification.reason}. It is on the never-run list. If this is genuinely required, the user must run it themselves.`;
  }

  const id = ctx.commands.nextId();
  const autoRun = classification.verdict === 'auto' && !ctx.settings.requireApprovalForAll;

  ctx.onCommandProposed({
    id,
    command,
    cwd: toBashPath(cwd),
    reason: classification.reason,
    autoRun
  });

  if (!autoRun) {
    const decision = await new Promise<'approved' | 'rejected'>((resolve) => {
      ctx.commands.register({ id, command, cwd, classification, resolve });
      if (ctx.token.isCancellationRequested) {
        ctx.commands.reject(id);
        return;
      }
      ctx.token.onCancellationRequested(() => ctx.commands.reject(id));
    });

    if (decision === 'rejected') {
      ctx.recorder.add('command', `${command} (declined by user)`, null);
      return `The user DECLINED to run \`${command}\`. It did not run and nothing changed. Do not retry it — either find a read-only way to get what you need, or ask what they would prefer.`;
    }
  }

  let bash: string;
  try {
    bash = resolveBash(ctx);
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }

  const result = await runCommand(command, {
    cwd,
    bashPath: bash,
    timeoutMs,
    token: ctx.token
  });

  ctx.recorder.add('command', command, result.exitCode);
  ctx.onCommandFinished({
    id,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    output: (result.stdout + (result.stderr ? `\n${result.stderr}` : '')).slice(-4000)
  });

  return formatResult(result);
}

async function toolRunCommand(args: any, ctx: ToolContext): Promise<string> {
  const command = String(args.command ?? '').trim();
  if (!command) {
    return 'Error: command is required.';
  }

  let cwd: string;
  try {
    cwd = resolveCwd(args.cwd);
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }

  const seconds = Math.min(Math.max(Number(args.timeout_seconds) || 120, 1), 600);
  return executeGated(command, cwd, ctx, seconds * 1000);
}

async function toolGit(gitArgs: string[], ctx: ToolContext): Promise<string> {
  const cwd = resolveCwd(undefined);
  const command = `git ${gitArgs.join(' ')}`;
  return executeGated(command, cwd, ctx, 60_000);
}

async function toolGitDiff(args: any, ctx: ToolContext): Promise<string> {
  const parts = ['diff'];
  if (args.staged) parts.push('--staged');
  if (args.stat_only) parts.push('--stat');
  parts.push('--no-color');
  if (args.path) {
    const { relPath } = resolveInWorkspace(String(args.path));
    parts.push('--', `"${relPath}"`);
  }
  return toolGit(parts, ctx);
}

interface Check {
  kind: 'typecheck' | 'lint' | 'test' | 'build';
  command: string;
}

/** Reads the project's real manifests so validation uses its actual scripts. */
async function discoverChecks(ctx: ToolContext): Promise<Check[]> {
  const root = workspaceFolders()[0].uri;
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

  const pkg = await readJson('package.json');
  if (pkg?.scripts && typeof pkg.scripts === 'object') {
    const scripts = pkg.scripts as Record<string, string>;
    const pick = (kind: Check['kind'], candidates: string[]): void => {
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

  const exists = async (name: string): Promise<boolean> => {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, name));
      return true;
    } catch {
      return false;
    }
  };

  if (await exists('pyproject.toml')) {
    if (!checks.some((c) => c.kind === 'test')) {
      checks.push({ kind: 'test', command: 'python -m pytest -q' });
    }
    if (!checks.some((c) => c.kind === 'lint')) {
      checks.push({ kind: 'lint', command: 'python -m ruff check .' });
    }
  } else if ((await exists('pytest.ini')) || (await exists('tests'))) {
    if (!checks.some((c) => c.kind === 'test')) {
      checks.push({ kind: 'test', command: 'python -m pytest -q' });
    }
  }

  if (
    !checks.some((c) => c.kind === 'typecheck') &&
    (await exists('tsconfig.json'))
  ) {
    checks.push({ kind: 'typecheck', command: 'npx tsc --noEmit' });
  }

  return checks;
}

async function toolRunValidation(args: any, ctx: ToolContext): Promise<string> {
  let checks: Check[];
  try {
    checks = await discoverChecks(ctx);
  } catch (e) {
    return `Error discovering validation scripts: ${(e as Error).message}`;
  }

  const wanted: string[] = Array.isArray(args?.kinds) ? args.kinds.map(String) : [];
  const selected = wanted.length
    ? checks.filter((c) => wanted.includes(c.kind))
    : checks;

  if (selected.length === 0) {
    return checks.length === 0
      ? 'No validation scripts found. There is no package.json with lint/test/build scripts, no tsconfig.json and no Python test setup in this workspace. Say so rather than claiming the project was validated.'
      : `None of the requested checks exist. Available: ${checks.map((c) => c.kind).join(', ')}.`;
  }

  const cwd = resolveCwd(undefined);
  const report: string[] = [];

  for (const check of selected) {
    if (ctx.token.isCancellationRequested) {
      report.push(`${check.kind}: skipped (cancelled)`);
      break;
    }
    const output = await executeGated(check.command, cwd, ctx, 300_000);
    const passed = /exit 0\b/.test(output.split('\n')[1] ?? '');
    ctx.recorder.add(
      'validation',
      `${check.kind} (${check.command}): ${passed ? 'passed' : 'FAILED'}`
    );
    report.push(`### ${check.kind} — ${check.command}\n${output}`);
  }

  return [
    'Validation results. Report only these outcomes; do not claim any check passed that is not shown here.',
    '',
    ...report
  ].join('\n');
}

function toolRecord(args: any, ctx: ToolContext): string {
  const kind = String(args?.kind ?? 'note');
  const text = String(args?.text ?? '').trim();
  if (!text) {
    return 'Error: text is required.';
  }
  const allowed = ['requirement', 'decision', 'file-changed', 'bug', 'fix', 'todo', 'note'];
  if (!allowed.includes(kind)) {
    return `Error: kind must be one of ${allowed.join(', ')}.`;
  }
  ctx.recorder.add(kind as any, text);
  return `Recorded (${kind}). It will appear in the session report and the local session log.`;
}

function toolDiagnostics(args: any): string {
  const severityName = (s: vscode.DiagnosticSeverity) =>
    ['Error', 'Warning', 'Info', 'Hint'][s] ?? 'Info';

  const format = (uri: vscode.Uri, ds: readonly vscode.Diagnostic[]) =>
    ds
      .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
      .map(
        (d) =>
          `${displayPath(uri)}:${d.range.start.line + 1}:${
            d.range.start.character + 1
          } ${severityName(d.severity)}: ${d.message}`
      );

  if (args?.path) {
    const { uri, relPath } = resolveInWorkspace(String(args.path));
    const lines = format(uri, vscode.languages.getDiagnostics(uri));
    return lines.length
      ? lines.join('\n')
      : `No errors or warnings reported for ${relPath}.`;
  }

  const all: string[] = [];
  for (const [uri, ds] of vscode.languages.getDiagnostics()) {
    all.push(...format(uri, ds));
    if (all.length > 200) {
      break;
    }
  }
  return all.length
    ? all.slice(0, 200).join('\n')
    : 'No errors or warnings reported in the workspace.';
}
