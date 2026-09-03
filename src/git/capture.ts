import * as vscode from 'vscode';
import { Settings } from '../config';
import { findBash, runCommand } from '../shell/exec';
import {
  buildBaseline,
  EMPTY_BASELINE,
  GitBaseline,
  GitFileStatus,
  parseStatus
} from './baseline';

/**
 * Reads the working tree directly rather than through `run_command`.
 *
 * The baseline has to be captured before the agents start, and it is not the
 * model's call whether to take it — routing it through the approval-gated tool
 * would mean a user declining `git status` silently disables the protection
 * that stops their uncommitted work being overwritten. `git status` only
 * reads, so taking it directly is safe and makes the guarantee unconditional.
 */
const STATUS_COMMAND = 'git status --porcelain=v1 --branch --untracked-files=all';

async function readStatus(
  cwd: string,
  settings: Settings,
  token: vscode.CancellationToken
): Promise<{ ok: boolean; stdout: string }> {
  const bash = findBash(settings.bashPath);
  if (!bash) {
    return { ok: false, stdout: '' };
  }
  try {
    const result = await runCommand(STATUS_COMMAND, {
      cwd,
      bashPath: bash,
      timeoutMs: 15_000,
      token
    });
    return { ok: result.exitCode === 0, stdout: result.stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/**
 * Snapshots the working tree before a run.
 *
 * A workspace that is not a repository, or a machine without git, degrades to
 * an empty baseline rather than failing the run — the protection is then
 * simply unavailable, which the verifier reports.
 */
export async function captureBaseline(
  cwd: string,
  settings: Settings,
  token: vscode.CancellationToken
): Promise<GitBaseline> {
  const { ok, stdout } = await readStatus(cwd, settings, token);
  if (!ok) {
    return { ...EMPTY_BASELINE, capturedAt: new Date().toISOString() };
  }
  return buildBaseline(stdout, { isRepo: true });
}

/** The working tree as it stands now, for comparison against the baseline. */
export async function currentStatus(
  cwd: string,
  settings: Settings,
  token: vscode.CancellationToken
): Promise<GitFileStatus[]> {
  const { ok, stdout } = await readStatus(cwd, settings, token);
  return ok ? parseStatus(stdout) : [];
}
