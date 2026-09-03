import * as vscode from 'vscode';
import { Settings } from './config';
import { findBash, toBashPath } from './shell/exec';
import { AgentMode, modeProfile } from './agent/mode';
import { composeEngineeringPrompt, PromptStack } from './prompt/systemPrompt';

/**
 * Assembles the system prompt for a turn, in three layers:
 *
 * 1. **Environment** — live facts (workspace roots, OS, resolved shell).
 * 2. **Engineering standards** — the sections `src/prompt/systemPrompt.ts`
 *    holds, selected by the mode's tiers so Fast mode does not pay for the
 *    full 11k-token document.
 * 3. **This extension's tools** — the rules that are actually *enforceable*
 *    here, and which deliberately override layer 2 wherever the two differ.
 *    "Do not claim a test passed" means something because `run_validation`
 *    returns real exit codes; "open Git Bash yourself" does not apply,
 *    because commands go through `run_command` and a policy gate.
 *
 * Layer 3 comes last because the specific must beat the general.
 */
export function buildSystemPrompt(
  settings: Settings,
  mode: AgentMode,
  stacks?: readonly PromptStack[]
): string {
  const profile = modeProfile(mode);
  const folders = vscode.workspace.workspaceFolders ?? [];
  const rootInfo = folders.length
    ? folders.map((f) => `${f.name} — ${toBashPath(f.uri.fsPath)}`).join('; ')
    : 'none (no folder is open, so the workspace tools are unavailable)';

  const bash = findBash(settings.bashPath);
  const shellInfo = bash
    ? `${bash}${process.platform === 'win32' ? ' (Git Bash)' : ''}`
    : 'not found — run_command will fail until Git Bash is installed or "azureAiChat.shell.bashPath" is set';

  const approvalRule = settings.requireApprovalForAll
    ? 'Every command waits for the user to approve it.'
    : "Read-only commands and the project's own lint / type-check / test / build scripts run immediately. Anything that changes files, packages, the git repository or the machine waits for the user to approve it, and a small set of catastrophic commands is refused outright.";

  const toolList = profile.allowedTools
    ? profile.allowedTools.join(', ')
    : 'read_file, list_files, search_workspace, apply_patch, write_file, run_command, git_status, git_diff, run_validation, get_diagnostics, record_session';

  const environment = `# Environment

- Workspace folder(s): ${rootInfo}
- Operating system: ${process.platform}${process.platform === 'win32' ? ' (Windows)' : ''}
- Shell for run_command: ${shellInfo}
- Paths you pass to file tools are workspace-relative with forward slashes. Paths **inside** the shell are Git Bash style, so \`C:\\Users\\me\\proj\` is \`/c/Users/me/proj\`.
- Mode for this turn: **${profile.label}** — ${profile.description}`;

  const engineering = composeEngineeringPrompt({
    tiers: profile.tiers,
    stacks
  });

  const harness = `# Working in this extension

Everything above is the general standard. This section describes the tools you actually have, and **overrides the general guidance wherever the two differ.**

Tools available this turn: ${toolList}.

- You do **not** open a terminal, and you do **not** have an interactive shell. Commands go through \`run_command\`, which runs one non-interactive command and returns its output. stdin is closed, so never run a watcher, a dev server, or anything that prompts.
- You do **not** write session or conversation-history files yourself. \`record_session\` does that, with secrets redacted. Do not create files under the temp directory to track context.
- You do **not** write to disk directly. \`write_file\` *proposes* a change; the user sees a diff and accepts or rejects it, and the tool result tells you which happened.

## Running commands

${approvalRule}

- Do not tell the user to run a command you could run yourself. Run it, read the output, and act on it.
- When a command fails: read the error, form a hypothesis, inspect the relevant code or config, fix the cause, and run it again. Do not retry blindly and do not silence an error to make a command succeed.
- If the user declines a command, do not retry it. Find a read-only route to the same information, or ask what they would prefer.

## Editing files

- \`read_file\` before you edit, every time. Both edit tools need your text to be based on what is actually in the file.
- **\`apply_patch\` is the default for a file that already exists.** You send only the snippets that change, so the parts you are not touching cannot be lost. Copy each \`find\` exactly from what \`read_file\` returned, including indentation, and include enough surrounding lines that it matches exactly one place.
- \`write_file\` is for creating a new file, or for a rewrite that genuinely replaces the whole thing. It replaces every byte, so never use it to change a few lines.
- Never write placeholders such as \`// ... rest of file unchanged\`. With \`write_file\` that destroys the file; with \`apply_patch\` it will simply not match.
- If a patch does not match, the tool tells you why and nothing was changed. Re-read the file and quote it exactly — do not switch to \`write_file\` to force it through.
- If an edit is rejected, do not re-send it — ask what they want different.
- Make the smallest change that solves the problem.

## Validating your work

- \`run_validation\` reads package.json / pyproject.toml and runs the project's real scripts. Prefer it over guessing command names.
- \`get_diagnostics\` is a fast check for type and lint errors in a file you just changed.
- Review your own work with \`git_diff\` before you report that you are done.
- **Never claim that a build, test, type-check or lint passed unless you ran it and saw it pass.** Distinguish clearly between what you implemented and what you verified. If you did not run something, say so.

## Secrets

- Never print, echo, commit or repeat a secret value. If an environment variable is missing, name it (\`AZURE_OPENAI_API_KEY is missing\`) and never show its contents. Never write secrets into files or session notes.

## How to reply

- Be concise and concrete. Lead with the answer. Reference files as \`path/to/file.ts:42\`.
- Use fenced code blocks with a language tag.
- Do not reveal your private reasoning. Report what you found, what you changed, and what you verified.
- If something is genuinely ambiguous, ask one focused question rather than guessing at length.
- Say plainly when you are unsure or when you did not verify something.`;

  return [environment, engineering, harness, profile.guidance]
    .filter(Boolean)
    .join('\n\n---\n\n');
}

export function withUserPrompt(base: string, settings: Settings): string {
  const extra = settings.systemPrompt.trim();
  return extra
    ? `${base}\n\n# Additional instructions from the user\n\n${extra}`
    : base;
}

export interface EditorContext {
  relPath: string;
  languageId: string;
  text: string;
  selection?: string;
  selectionStartLine?: number;
  selectionEndLine?: number;
}

export function captureEditorContext(settings: Settings): EditorContext | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return undefined;
  }
  const doc = editor.document;
  const full = doc.getText();
  const text =
    full.length > settings.maxFileBytes
      ? `${full.slice(0, settings.maxFileBytes)}\n[... truncated ...]`
      : full;

  const sel = editor.selection;
  const hasSelection = sel && !sel.isEmpty;

  return {
    relPath: vscode.workspace.asRelativePath(doc.uri, false),
    languageId: doc.languageId,
    text,
    selection: hasSelection ? doc.getText(sel) : undefined,
    selectionStartLine: hasSelection ? sel.start.line + 1 : undefined,
    selectionEndLine: hasSelection ? sel.end.line + 1 : undefined
  };
}

export function renderEditorContext(ctx: EditorContext): string {
  const parts: string[] = [
    `[Active editor — ${ctx.relPath}]`,
    '```' + ctx.languageId,
    ctx.text,
    '```'
  ];
  if (ctx.selection) {
    parts.push(
      '',
      `[Current selection, lines ${ctx.selectionStartLine}-${ctx.selectionEndLine} of ${ctx.relPath}]`,
      '```' + ctx.languageId,
      ctx.selection,
      '```'
    );
  }
  return parts.join('\n');
}
