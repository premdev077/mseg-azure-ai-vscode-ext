/**
 * What an agent is allowed to modify.
 *
 * Scope restricts **writes, not reads**. An agent that cannot read outside its
 * lane produces worse changes — it needs to see the caller it is about to
 * break, the type it must satisfy, the test that covers it. What it must not
 * do is edit a file another agent owns, which is what this enforces.
 *
 * An agent that genuinely needs a file outside its scope asks the Coordinator
 * rather than reaching for it; the refusal message says so.
 */
export interface AgentScope {
  /** Exact workspace-relative paths this agent may modify. */
  allowedFiles?: string[];
  /**
   * Directory prefixes this agent may modify, e.g. `src/api`. A trailing
   * `/**` is accepted and ignored, since that is how the plan reads.
   */
  allowedDirectories?: string[];
}

export type ScopeVerdict = { allowed: true } | { allowed: false; reason: string };

function normalise(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/** Strips the glob tail a plan usually carries: `src/api/**` → `src/api`. */
function normaliseDirectory(p: string): string {
  return normalise(p)
    .replace(/\/?\*+$/, '')
    .replace(/\/+$/, '');
}

function withinDirectory(filePath: string, directory: string): boolean {
  if (directory === '' || directory === '.') {
    return true;
  }
  return filePath === directory || filePath.startsWith(`${directory}/`);
}

/**
 * Whether `relPath` may be modified under `scope`.
 *
 * An undefined scope, or one with no rules, means unrestricted — which is what
 * the single-agent path uses and must keep working. Restriction is opt-in, so
 * a task the Coordinator did not scope behaves exactly as before.
 */
export function checkScope(relPath: string, scope?: AgentScope): ScopeVerdict {
  if (!scope) {
    return { allowed: true };
  }
  const files = (scope.allowedFiles ?? []).map(normalise).filter(Boolean);
  const directories = (scope.allowedDirectories ?? [])
    .map(normaliseDirectory)
    .filter((d) => d.length > 0);

  if (files.length === 0 && directories.length === 0) {
    return { allowed: true };
  }

  const target = normalise(relPath);
  if (files.includes(target)) {
    return { allowed: true };
  }
  if (directories.some((dir) => withinDirectory(target, dir))) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason:
      `Refused: "${relPath}" is outside this agent's assigned scope. ` +
      `You may modify ${describeScope(scope)}. ` +
      'If this file genuinely needs to change, say so in your result and let the Coordinator assign it — do not work around this.'
  };
}

/** Human-readable scope, for a refusal message or an agent card. */
export function describeScope(scope?: AgentScope): string {
  if (!scope) {
    return 'any file in the workspace';
  }
  const parts: string[] = [];
  for (const dir of scope.allowedDirectories ?? []) {
    parts.push(`${normaliseDirectory(dir)}/**`);
  }
  for (const file of scope.allowedFiles ?? []) {
    parts.push(normalise(file));
  }
  return parts.length > 0 ? parts.join(', ') : 'any file in the workspace';
}

/**
 * Groups a plan's file changes into scopes that do not overlap.
 *
 * Two agents assigned the same file would contend for its lock and serialise
 * anyway, so the split is by top-level area: work that cannot collide runs
 * together, and anything that would collide lands on one agent instead.
 */
export function partitionByArea(
  filePaths: string[],
  maxGroups: number
): Array<{ area: string; files: string[] }> {
  if (filePaths.length === 0 || maxGroups < 1) {
    return [];
  }

  const byArea = new Map<string, string[]>();
  for (const raw of filePaths) {
    const path = normalise(raw);
    if (!path) {
      continue;
    }
    const segments = path.split('/');
    // Group on the first two segments where there are any, so `src/auth` and
    // `src/api` separate instead of everything collapsing into `src`.
    const area =
      segments.length > 2
        ? `${segments[0]}/${segments[1]}`
        : segments.length === 2
          ? segments[0]
          : '.';
    const list = byArea.get(area) ?? [];
    list.push(path);
    byArea.set(area, list);
  }

  // Largest areas first, so merging the tail into the last group keeps the
  // biggest units of work separate.
  const groups = [...byArea.entries()]
    .map(([area, files]) => ({ area, files: [...new Set(files)].sort() }))
    .sort((a, b) => b.files.length - a.files.length || a.area.localeCompare(b.area));

  if (groups.length <= maxGroups) {
    return groups;
  }

  const kept = groups.slice(0, maxGroups - 1);
  const merged = groups.slice(maxGroups - 1);
  kept.push({
    area: merged.map((g) => g.area).join(', '),
    files: [...new Set(merged.flatMap((g) => g.files))].sort()
  });
  return kept;
}
