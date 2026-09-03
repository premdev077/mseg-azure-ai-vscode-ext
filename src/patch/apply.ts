/**
 * Anchored search/replace patching.
 *
 * Whole-file rewrites are what `write_file` does, and they are the wrong tool
 * for changing four lines in a thousand-line file: the model has to reproduce
 * everything it is not changing, and any slip silently destroys work. With more
 * than one agent editing, they are worse than wrong — two whole-file writes to
 * one path means last-write-wins across the entire file.
 *
 * So an edit is an exact snippet to find and what to put in its place. The
 * `find` text must match exactly once. Refusing an ambiguous match is the whole
 * safety property: a `find` that appears twice is the model not having read
 * enough context, and guessing which one it meant is how the wrong line gets
 * rewritten.
 */
export interface PatchEdit {
  /** Exact text to locate. Must occur exactly once in the file. */
  find: string;
  /** What replaces it. Empty string deletes the matched text. */
  replace: string;
}

export type PatchOutcome =
  | { ok: true; text: string; applied: number; normalisedEol: boolean }
  | { ok: false; error: string; failedAt: number };

/** The dominant line ending, so a replacement matches the file it lands in. */
export function detectEol(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) {
    return '\n';
  }
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf >= lf ? '\r\n' : '\n';
}

function toEol(text: string, eol: '\r\n' | '\n'): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      return count;
    }
    count += 1;
    from = at + needle.length;
  }
}

/** Short, quoted context for an error message. */
function excerpt(text: string, limit = 120): string {
  const flat = text.replace(/\r?\n/g, '↵').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Applies each edit in order, every one against the result of the last.
 *
 * Line endings are reconciled rather than trusted. A model that read a CRLF
 * file will usually send LF back, and a literal comparison would then find
 * nothing in a file that plainly contains the text — so the snippet is
 * retried in the file's own line ending before it is called a miss.
 */
export function applyEdits(original: string, edits: PatchEdit[]): PatchOutcome {
  if (edits.length === 0) {
    return { ok: false, error: 'No edits were supplied.', failedAt: -1 };
  }

  const eol = detectEol(original);
  let text = original;
  let normalisedEol = false;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const rawFind = edit.find ?? '';

    if (rawFind === '') {
      return {
        ok: false,
        error: `Edit ${i + 1} has an empty "find". Give the exact text to replace.`,
        failedAt: i
      };
    }

    // Exact first; only reconcile line endings if that finds nothing.
    let find = rawFind;
    let hits = countOccurrences(text, find);

    if (hits === 0) {
      const converted = toEol(rawFind, eol);
      if (converted !== rawFind) {
        const convertedHits = countOccurrences(text, converted);
        if (convertedHits > 0) {
          find = converted;
          hits = convertedHits;
          normalisedEol = true;
        }
      }
    }

    if (hits === 0) {
      return {
        ok: false,
        error:
          `Edit ${i + 1} did not match. No occurrence of:\n"${excerpt(rawFind)}"\n` +
          'Read the file again and copy the text exactly, including indentation. ' +
          (i > 0
            ? `Note that edits 1-${i} were applied first, so quote the file as it is after those.`
            : ''),
        failedAt: i
      };
    }

    if (hits > 1) {
      return {
        ok: false,
        error:
          `Edit ${i + 1} is ambiguous: "${excerpt(rawFind)}" occurs ${hits} times. ` +
          'Include more surrounding context so it matches exactly one place. ' +
          'Nothing was changed.',
        failedAt: i
      };
    }

    // The replacement always adopts the file's line endings, whether or not the
    // `find` needed converting. A single-line `find` can carry a multi-line
    // `replace`, and inserting bare LF into a CRLF file leaves mixed endings
    // that show up as spurious whole-file churn in the next diff.
    const replace = toEol(edit.replace ?? '', eol);
    const at = text.indexOf(find);
    text = text.slice(0, at) + replace + text.slice(at + find.length);
  }

  if (text === original) {
    return {
      ok: false,
      error:
        'The edits applied cleanly but left the file byte-for-byte unchanged. ' +
        'Nothing was proposed.',
      failedAt: -1
    };
  }

  return { ok: true, text, applied: edits.length, normalisedEol };
}

/**
 * Validates the tool's raw argument into edits.
 *
 * Kept separate from `applyEdits` because the model supplies this shape and
 * gets the message back: a precise complaint about argument 2 is worth more
 * than a generic parse failure.
 */
export function parseEdits(
  raw: unknown
): { ok: true; edits: PatchEdit[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: '"edits" must be an array of {find, replace} objects.'
    };
  }
  if (raw.length === 0) {
    return { ok: false, error: '"edits" was empty; there is nothing to apply.' };
  }

  const edits: PatchEdit[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown> | null;
    if (!item || typeof item !== 'object') {
      return { ok: false, error: `Edit ${i + 1} is not an object.` };
    }
    if (typeof item.find !== 'string') {
      return { ok: false, error: `Edit ${i + 1} is missing a string "find".` };
    }
    if (item.replace !== undefined && typeof item.replace !== 'string') {
      return {
        ok: false,
        error: `Edit ${i + 1} has a "replace" that is not a string.`
      };
    }
    edits.push({ find: item.find, replace: (item.replace as string) ?? '' });
  }
  return { ok: true, edits };
}
