/**
 * A snapshot of the working tree before the agents touch it.
 *
 * Without this the run cannot tell its own edits from work the user already
 * had in progress — and "the AI must never destroy uncommitted user changes"
 * is not enforceable by good intentions. The verifier compares the final diff
 * against this snapshot, so a file that changed but that no agent claimed is
 * reported rather than quietly attributed to the run.
 *
 * Parsing lives here, free of any `vscode` or shell import, so the
 * classification logic is testable without a repository.
 */
export type GitFileState =
  'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface GitFileStatus {
  filePath: string;
  state: GitFileState;
  /** True when the change is staged. */
  staged: boolean;
}

export interface GitBaseline {
  /** True when the workspace is a git repository at all. */
  isRepo: boolean;
  branch?: string;
  /** Files already dirty before the run started. */
  dirtyFiles: GitFileStatus[];
  capturedAt: string;
}

export const EMPTY_BASELINE: GitBaseline = {
  isRepo: false,
  dirtyFiles: [],
  capturedAt: new Date(0).toISOString()
};

function stateFor(code: string): GitFileState {
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    case 'U':
      return 'conflicted';
    default:
      return 'modified';
  }
}

/**
 * Parses `git status --porcelain=v1`.
 *
 * v1 is deliberate: the format is stable across every git version this is
 * likely to meet, and the two status columns are all that is needed here.
 */
export function parseStatus(stdout: string): GitFileStatus[] {
  const files: GitFileStatus[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (line.length < 4) {
      continue;
    }
    // `--branch` prepends `## main...origin/main`. Without this the header is
    // read as a staged file called "main".
    if (line.startsWith('##')) {
      continue;
    }
    const index = line[0];
    const worktree = line[1];
    let rest = line.slice(3).trim();

    if (index === '?' && worktree === '?') {
      files.push({ filePath: unquote(rest), state: 'untracked', staged: false });
      continue;
    }
    if (index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A')) {
      files.push({ filePath: unquote(rest), state: 'conflicted', staged: false });
      continue;
    }

    // A rename reads `old -> new`; the new path is the one that matters.
    const arrow = rest.indexOf(' -> ');
    if (arrow !== -1) {
      rest = rest.slice(arrow + 4);
    }
    const filePath = unquote(rest);

    if (index !== ' ' && index !== '?') {
      files.push({ filePath, state: stateFor(index), staged: true });
    }
    if (worktree !== ' ' && worktree !== '?') {
      files.push({ filePath, state: stateFor(worktree), staged: false });
    }
  }

  return files;
}

/** Git quotes paths containing unusual characters. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** `## main...origin/main [ahead 1]` → `main`. */
export function parseBranch(stdout: string): string | undefined {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('## '));
  if (!line) {
    return undefined;
  }
  const body = line.slice(3).trim();
  if (body.startsWith('HEAD (no branch)')) {
    return 'HEAD (detached)';
  }
  return body.split(/\.{3}|\s+/)[0] || undefined;
}

export function buildBaseline(
  statusOutput: string,
  options: { isRepo: boolean; capturedAt?: string } = { isRepo: true }
): GitBaseline {
  if (!options.isRepo) {
    return {
      ...EMPTY_BASELINE,
      capturedAt: options.capturedAt ?? new Date().toISOString()
    };
  }
  return {
    isRepo: true,
    branch: parseBranch(statusOutput),
    dirtyFiles: parseStatus(statusOutput),
    capturedAt: options.capturedAt ?? new Date().toISOString()
  };
}

function normalise(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export interface ChangeAttribution {
  /** Files the run changed and claimed. Expected. */
  claimed: string[];
  /**
   * Files that changed but no agent claimed. Either something edited a file
   * outside the change log, or the user edited during the run. Either way the
   * verifier must not pass silently over it.
   */
  unexpected: string[];
  /**
   * Files the run changed that were **already dirty** before it started. The
   * user's uncommitted work and the agent's edit are now mixed in one file, so
   * this needs saying explicitly.
   */
  touchedPreexisting: string[];
  /** Files dirty before the run and untouched by it. Left alone, as required. */
  preservedPreexisting: string[];
}

/**
 * Sorts the final working-tree state into who did what.
 *
 * The distinction that matters is `touchedPreexisting`: overwriting a file the
 * user had already edited is the failure mode the whole baseline exists to
 * catch, and it cannot be seen from the final diff alone.
 */
export function attributeChanges(
  baseline: GitBaseline,
  finalStatus: GitFileStatus[],
  claimedByAgents: string[]
): ChangeAttribution {
  const before = new Set(baseline.dirtyFiles.map((f) => normalise(f.filePath)));
  const after = new Set(finalStatus.map((f) => normalise(f.filePath)));
  const claimed = new Set(claimedByAgents.map(normalise));

  const unexpected: string[] = [];
  for (const file of after) {
    if (!claimed.has(file) && !before.has(file)) {
      unexpected.push(file);
    }
  }

  const touchedPreexisting: string[] = [];
  const preservedPreexisting: string[] = [];
  for (const file of before) {
    if (claimed.has(file)) {
      touchedPreexisting.push(file);
    } else {
      preservedPreexisting.push(file);
    }
  }

  return {
    claimed: [...claimed].filter((f) => after.has(f)).sort(),
    unexpected: unexpected.sort(),
    touchedPreexisting: touchedPreexisting.sort(),
    preservedPreexisting: preservedPreexisting.sort()
  };
}

/** A warning to put in front of an agent before it edits a dirty file. */
export function preexistingWarning(
  baseline: GitBaseline,
  filePath: string
): string | undefined {
  const key = normalise(filePath);
  const entry = baseline.dirtyFiles.find((f) => normalise(f.filePath) === key);
  if (!entry) {
    return undefined;
  }
  return (
    `WARNING: ${filePath} already had uncommitted changes before this run started ` +
    `(${entry.state}${entry.staged ? ', staged' : ''}). Those are the user's work. ` +
    'Change only what this task requires, and never revert or rewrite the surrounding edits.'
  );
}
