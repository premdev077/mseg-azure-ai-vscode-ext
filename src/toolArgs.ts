/**
 * Readers for tool arguments.
 *
 * Tool arguments arrive as JSON the model wrote, so they are `unknown` at the
 * boundary and narrowed here rather than asserted with `any`. The model gets
 * the schema, but nothing enforces it — a missing field, a number where a
 * string belongs, or a null is a normal Tuesday, and every one of those used
 * to reach the tool body as a lie the compiler had agreed to.
 *
 * Each reader takes the raw value and returns something usable or a stated
 * default, so a tool body never has to check twice.
 */
export type ToolArgs = Record<string, unknown>;

/** Parses the raw argument string. Never throws; the caller reports the error. */
export function parseToolArgs(
  raw: string
): { ok: true; args: ToolArgs } | { ok: false; error: string } {
  if (!raw || raw.trim().length === 0) {
    return { ok: true, args: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `arguments were not valid JSON: ${raw.slice(0, 400)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'arguments were not a JSON object.' };
  }
  return { ok: true, args: parsed as ToolArgs };
}

export function readString(args: ToolArgs, key: string, fallback = ''): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

/** Undefined rather than a default, for genuinely optional arguments. */
export function readOptionalString(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A number, accepting the numeric string models sometimes send.
 *
 * `NaN` is treated as absent: a tool that received `limit: "abc"` should use
 * its default, not silently compare against NaN and return nothing.
 */
export function readNumber(args: ToolArgs, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function readBoolean(args: ToolArgs, key: string): boolean {
  return args[key] === true;
}

export function readStringArray(args: ToolArgs, key: string): string[] {
  const value = args[key];
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

/** The raw value, for a reader that needs to do its own structural checking. */
export function readRaw(args: ToolArgs, key: string): unknown {
  return args[key];
}

/**
 * Narrows a string to one of a known set.
 *
 * Returns undefined for anything else, so a caller can report which values are
 * allowed instead of proceeding with a value the rest of the code cannot mean.
 */
export function readEnum<T extends string>(
  args: ToolArgs,
  key: string,
  allowed: readonly T[]
): T | undefined {
  const value = args[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}
