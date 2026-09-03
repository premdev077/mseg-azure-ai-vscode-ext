/**
 * A deliberately small markdown subset.
 *
 * Model and tool output is untrusted input rendered inside the user's editor,
 * so this is a security boundary, not a formatting convenience. A general
 * markdown library is a large parser plus an HTML sanitiser for a panel that
 * renders prose, code and the occasional emphasis.
 *
 * The safety property is simple enough to check by reading: the text is
 * escaped *first*, so no `<` from the model survives, and only a fixed set of
 * tags is added afterwards from patterns matched against already-escaped text.
 * Nothing is ever interpolated into an attribute.
 *
 * This lives outside the component because it is logic, and because it is
 * worth testing directly rather than through a render.
 */
export interface TextBlock {
  readonly kind: 'text';
  readonly content: string;
}

export interface CodeBlock {
  readonly kind: 'code';
  readonly content: string;
  readonly lang?: string | undefined;
}

export type Block = TextBlock | CodeBlock;

/** Splits on fenced code, keeping an unterminated fence as code while it streams. */
export function parseBlocks(raw: string): Block[] {
  const blocks: Block[] = [];
  const fence = /```([\w+-]*)\r?\n?([\s\S]*?)(?:```|$)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(raw)) !== null) {
    if (match.index > cursor) {
      blocks.push({ kind: 'text', content: raw.slice(cursor, match.index) });
    }
    blocks.push({
      kind: 'code',
      lang: match[1] !== undefined && match[1].length > 0 ? match[1] : undefined,
      content: match[2] ?? ''
    });
    cursor = fence.lastIndex;
  }
  if (cursor < raw.length) {
    blocks.push({ kind: 'text', content: raw.slice(cursor) });
  }

  return blocks.filter((b) => b.kind === 'code' || b.content.trim().length > 0);
}

/**
 * Escapes every character that could open a tag or an entity.
 *
 * Quotes are escaped too. Nothing here writes into an attribute today, but a
 * later edit that does must not become an injection because this function
 * assumed it never would.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Inline formatting over already-escaped text.
 *
 * The order matters: escaping happens first, so the patterns below can only
 * match literal backticks and asterisks the model wrote, never markup.
 */
export function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(
      /\b([\w./-]+\.[a-z]{2,4}):(\d+)\b/g,
      '<span class="font-mono text-link">$1:$2</span>'
    );
}
