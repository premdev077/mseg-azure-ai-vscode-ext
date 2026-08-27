import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface ExecResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 100_000;

/**
 * Locates Git Bash on Windows, or the system shell elsewhere.
 * Git for Windows installs to a handful of well-known places; the `git`
 * executable on PATH is the reliable fallback because bash sits next to it.
 */
export function findBash(configured?: string): string | undefined {
  if (configured && configured.trim()) {
    const p = configured.trim();
    return fs.existsSync(p) ? p : undefined;
  }

  if (process.platform !== 'win32') {
    for (const p of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/bin/sh']) {
      if (fs.existsSync(p)) return p;
    }
    return undefined;
  }

  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
      : '',
    process.env.ProgramW6432
      ? path.join(process.env.ProgramW6432, 'Git', 'bin', 'bash.exe')
      : ''
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Derive it from wherever git itself lives.
  try {
    const gitPath = cp
      .execSync('where git', { encoding: 'utf8', timeout: 5000 })
      .split(/\r?\n/)[0]
      ?.trim();
    if (gitPath) {
      // ...\Git\cmd\git.exe  ->  ...\Git\bin\bash.exe
      const gitRoot = path.dirname(path.dirname(gitPath));
      const bash = path.join(gitRoot, 'bin', 'bash.exe');
      if (fs.existsSync(bash)) return bash;
    }
  } catch {
    /* git is not on PATH */
  }

  return undefined;
}

/** Renders a Windows path the way it appears inside Git Bash. */
export function toBashPath(winPath: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) {
    return winPath.replace(/\\/g, '/');
  }
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

function capOutput(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_OUTPUT_CHARS) {
    return { text: s, truncated: false };
  }
  const half = Math.floor(MAX_OUTPUT_CHARS / 2);
  return {
    text: `${s.slice(0, half)}\n\n... [${s.length - MAX_OUTPUT_CHARS} characters omitted] ...\n\n${s.slice(-half)}`,
    truncated: true
  };
}

/** Kills the whole process tree; a bare kill leaves children running. */
function killTree(child: cp.ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      cp.execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

export interface ExecOptions {
  cwd: string;
  bashPath: string;
  timeoutMs?: number;
  token?: vscode.CancellationToken;
  /** Called with output as it arrives, for the live view. */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export async function runCommand(
  command: string,
  options: ExecOptions
): Promise<ExecResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<ExecResult>((resolve) => {
    const child = cp.spawn(options.bashPath, ['-c', command], {
      cwd: options.cwd,
      // stdin is closed so anything that tries to prompt gets EOF and exits
      // instead of hanging the tool call forever.
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        CI: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        TERM: 'dumb',
        npm_config_yes: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8'
      }
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub?.dispose();
      const o = capOutput(stdout);
      const e = capOutput(stderr);
      resolve({
        command,
        cwd: options.cwd,
        exitCode,
        stdout: o.text,
        stderr: e.text,
        timedOut,
        durationMs: Date.now() - started,
        truncated: o.truncated || e.truncated
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      finish(null);
    }, timeoutMs);

    const sub = options.token?.onCancellationRequested(() => {
      killTree(child);
      finish(null);
    });

    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stdout += s;
      options.onOutput?.(s, 'stdout');
      if (stdout.length > MAX_OUTPUT_CHARS * 4) {
        killTree(child);
      }
    });

    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      stderr += s;
      options.onOutput?.(s, 'stderr');
    });

    child.on('error', (err: Error) => {
      stderr += `\n[failed to start: ${err.message}]`;
      finish(null);
    });

    child.on('close', (code: number | null) => finish(code));
  });
}

/** A compact rendering of a result for the model. */
export function formatResult(r: ExecResult): string {
  const lines: string[] = [
    `$ ${r.command}`,
    `(cwd: ${toBashPath(r.cwd)}, ${r.durationMs} ms, exit ${
      r.timedOut ? 'TIMED OUT' : r.exitCode
    })`
  ];

  if (r.stdout.trim()) {
    lines.push('', '--- stdout ---', r.stdout.trimEnd());
  }
  if (r.stderr.trim()) {
    lines.push('', '--- stderr ---', r.stderr.trimEnd());
  }
  if (!r.stdout.trim() && !r.stderr.trim()) {
    lines.push('', '(no output)');
  }
  if (r.timedOut) {
    lines.push(
      '',
      'The command was killed after exceeding the timeout. It may have been waiting for input, which is never available here.'
    );
  }
  return lines.join('\n');
}
