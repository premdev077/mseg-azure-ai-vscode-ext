/**
 * Decides whether a command may run unattended.
 *
 * The rule the user chose: anything that only reads (or runs the project's own
 * lint/type-check/test/build) executes immediately; anything that mutates the
 * working tree, the dependency graph, the remote or the machine waits for one
 * click; a small set of catastrophic commands is refused outright.
 *
 * Classification is deliberately conservative — an unrecognised command is
 * treated as mutating, so new tooling errs towards asking.
 */

export type Verdict = 'auto' | 'approve' | 'denied';

export interface Classification {
  verdict: Verdict;
  /** Why, in language that makes sense on an approval card. */
  reason: string;
  /** The segment that forced the verdict, for approve/denied. */
  offendingSegment?: string;
}

/** Commands that only inspect state. */
const READ_ONLY = new Set([
  'ls', 'dir', 'pwd', 'cd', 'cat', 'head', 'tail', 'wc', 'file', 'stat',
  'which', 'where', 'echo', 'printf', 'date', 'whoami', 'hostname', 'uname',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd', 'tree', 'du', 'df',
  'basename', 'dirname', 'realpath', 'readlink', 'sort', 'uniq', 'cut',
  'column', 'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'env', 'type',
  'command', 'test', 'true', 'false', 'seq', 'nl', 'jq', 'yq', 'xxd', 'od'
]);

/** git subcommands that do not change the repository. */
const GIT_READ_ONLY = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'remote', 'rev-parse', 'ls-files',
  'ls-tree', 'blame', 'describe', 'shortlog', 'reflog', 'whatchanged',
  'cat-file', 'symbolic-ref', 'name-rev', 'count-objects', 'var', 'help',
  'grep', 'difftool', 'range-diff', 'verify-commit'
]);

/** Runners that execute the project's own checks. */
const VALIDATION = new Set([
  'pytest', 'jest', 'vitest', 'mocha', 'tsc', 'eslint', 'prettier', 'ruff',
  'mypy', 'flake8', 'black', 'pylint', 'phpunit', 'rspec', 'gradle', 'mvn'
]);

/** Package-manager subcommands that only read. */
const PKG_READ_ONLY = new Set([
  '-v', '--version', 'ls', 'list', 'view', 'info', 'outdated', 'why',
  'config', 'root', 'prefix', 'bin', 'show', 'search', 'help', 'ping'
]);

/** npm/pnpm/yarn scripts that are validation rather than mutation. */
const SAFE_SCRIPTS = new Set([
  'build', 'test', 'lint', 'typecheck', 'type-check', 'check-types', 'check',
  'compile', 'tsc', 'format:check', 'validate', 'unit', 'e2e', 'coverage'
]);

const VERSION_FLAGS = new Set(['-v', '--version', '-version', 'version', '--help', '-h']);

/**
 * Splits a command line into segments on the shell's control operators, while
 * ignoring operators inside quotes. Every segment is classified, and the
 * strictest verdict wins.
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  let i = 0;

  while (i < command.length) {
    const c = command[i];

    if (quote) {
      current += c;
      if (c === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[++i];
      } else if (c === quote) {
        quote = null;
      }
      i++;
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      i++;
      continue;
    }

    if (c === '\\' && i + 1 < command.length) {
      current += c + command[i + 1];
      i += 2;
      continue;
    }

    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segments.push(current);
      current = '';
      i += 2;
      continue;
    }
    if (c === ';' || c === '|' || c === '\n' || c === '&') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }

    current += c;
    i++;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** Strips `FOO=bar` prefixes and returns the words of a segment. */
function words(segment: string): string[] {
  const raw = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const cleaned = raw.map((w) => w.replace(/^["']|["']$/g, ''));
  let start = 0;
  while (start < cleaned.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(cleaned[start])) {
    start++;
  }
  if (cleaned[start] === 'sudo' || cleaned[start] === 'doas') {
    start++;
  }
  return cleaned.slice(start);
}

function hasWriteRedirect(segment: string): boolean {
  // `>` and `>>` outside quotes; `2>&1` is not a file write.
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '>') {
      const rest = segment.slice(i + 1).trimStart();
      if (rest.startsWith('&')) {
        continue; // fd duplication
      }
      return true;
    }
  }
  return false;
}

const CATASTROPHIC: Array<{ test: RegExp; reason: string }> = [
  {
    test: /\brm\s+(-[a-zA-Z]*\s+)*(-[a-zA-Z]*[rf][a-zA-Z]*)\s+(\/|~|\/\*|\$HOME|[A-Za-z]:[\\/]?)\s*$/,
    reason: 'recursive delete of a filesystem or home root'
  },
  { test: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(\s|$)/, reason: 'recursive delete of /' },
  { test: /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;/, reason: 'fork bomb' },
  { test: /\bmkfs(\.\w+)?\b/, reason: 'formats a filesystem' },
  { test: /\bdd\b[^|;]*\bof=\/dev\//, reason: 'writes directly to a device' },
  { test: /\b(shutdown|reboot|halt|poweroff)\b/, reason: 'shuts the machine down' },
  { test: /\bchmod\s+-R\s+777\s+\/(\s|$)/, reason: 'opens permissions on /' },
  { test: /\b(format|diskpart)\s+[a-zA-Z]:/i, reason: 'formats a drive' },
  { test: /\bgit\s+push\b[^|;]*--force\b[^|;]*\b(main|master|develop)\b/, reason: 'force-pushes a protected branch' }
];

function classifySegment(segment: string): Classification {
  for (const { test, reason } of CATASTROPHIC) {
    if (test.test(segment)) {
      return { verdict: 'denied', reason, offendingSegment: segment };
    }
  }

  const w = words(segment);
  if (w.length === 0) {
    return { verdict: 'auto', reason: 'empty' };
  }

  const cmd = w[0].toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  const args = w.slice(1);
  const firstArg = (args[0] ?? '').toLowerCase();

  // A write redirect makes anything mutating.
  if (hasWriteRedirect(segment)) {
    return {
      verdict: 'approve',
      reason: 'writes output to a file',
      offendingSegment: segment
    };
  }

  if (cmd === 'git') {
    if (GIT_READ_ONLY.has(firstArg)) {
      return { verdict: 'auto', reason: `git ${firstArg} only reads the repository` };
    }
    return {
      verdict: 'approve',
      reason: `git ${firstArg || '(subcommand)'} changes the repository`,
      offendingSegment: segment
    };
  }

  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn' || cmd === 'bun') {
    if (PKG_READ_ONLY.has(firstArg) || VERSION_FLAGS.has(firstArg)) {
      return { verdict: 'auto', reason: `${cmd} ${firstArg} only reads` };
    }
    if (firstArg === 'test' || firstArg === 'run' || firstArg === 'run-script') {
      const script = (args[1] ?? '').toLowerCase();
      if (firstArg === 'test' || SAFE_SCRIPTS.has(script)) {
        return { verdict: 'auto', reason: 'runs the project\'s own checks' };
      }
      return {
        verdict: 'approve',
        reason: `"${script}" is not a known check script, so it may do anything`,
        offendingSegment: segment
      };
    }
    return {
      verdict: 'approve',
      reason: `${cmd} ${firstArg} changes installed packages`,
      offendingSegment: segment
    };
  }

  if (cmd === 'pip' || cmd === 'pip3' || cmd === 'poetry' || cmd === 'uv') {
    if (firstArg === 'list' || firstArg === 'show' || firstArg === 'freeze' || VERSION_FLAGS.has(firstArg)) {
      return { verdict: 'auto', reason: `${cmd} ${firstArg} only reads` };
    }
    return {
      verdict: 'approve',
      reason: `${cmd} ${firstArg} changes the environment`,
      offendingSegment: segment
    };
  }

  if (VALIDATION.has(cmd)) {
    // `prettier --write` and `eslint --fix` rewrite files.
    if (args.some((a) => a === '--write' || a === '--fix')) {
      return {
        verdict: 'approve',
        reason: `${cmd} would rewrite files`,
        offendingSegment: segment
      };
    }
    return { verdict: 'auto', reason: `${cmd} runs a project check` };
  }

  if (cmd === 'npx') {
    const tool = firstArg.replace(/^-+/, '');
    if (VALIDATION.has(tool)) {
      if (args.some((a) => a === '--write' || a === '--fix')) {
        return { verdict: 'approve', reason: `${tool} would rewrite files`, offendingSegment: segment };
      }
      return { verdict: 'auto', reason: `npx ${tool} runs a project check` };
    }
    return {
      verdict: 'approve',
      reason: 'npx runs an arbitrary package',
      offendingSegment: segment
    };
  }

  if (cmd === 'node' || cmd === 'python' || cmd === 'python3' || cmd === 'dotnet' || cmd === 'java' || cmd === 'go') {
    if (VERSION_FLAGS.has(firstArg)) {
      return { verdict: 'auto', reason: `${cmd} version check` };
    }
    if (cmd === 'go' && (firstArg === 'version' || firstArg === 'vet' || firstArg === 'test' || firstArg === 'list')) {
      return { verdict: 'auto', reason: `go ${firstArg} only reads or tests` };
    }
    return {
      verdict: 'approve',
      reason: `runs an arbitrary ${cmd} program`,
      offendingSegment: segment
    };
  }

  if (READ_ONLY.has(cmd)) {
    return { verdict: 'auto', reason: `${cmd} only reads` };
  }

  if (VERSION_FLAGS.has(firstArg)) {
    return { verdict: 'auto', reason: 'version check' };
  }

  return {
    verdict: 'approve',
    reason: `"${cmd}" is not a known read-only command`,
    offendingSegment: segment
  };
}

const ORDER: Record<Verdict, number> = { auto: 0, approve: 1, denied: 2 };

export function classifyCommand(command: string): Classification {
  // Catastrophic patterns are matched against the whole line first: some of
  // them (a fork bomb, for one) straddle the operators the splitter cuts on.
  for (const { test, reason } of CATASTROPHIC) {
    if (test.test(command)) {
      return { verdict: 'denied', reason, offendingSegment: command };
    }
  }

  const segments = splitSegments(command);
  if (segments.length === 0) {
    return { verdict: 'denied', reason: 'empty command' };
  }

  let worst: Classification = { verdict: 'auto', reason: 'reads only' };
  for (const segment of segments) {
    const c = classifySegment(segment);
    if (ORDER[c.verdict] > ORDER[worst.verdict]) {
      worst = c;
    }
  }
  return worst;
}
