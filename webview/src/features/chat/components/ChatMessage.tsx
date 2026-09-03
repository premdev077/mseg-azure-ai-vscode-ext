import { memo, useMemo } from 'react';
import type { MessageView } from '../../../types/view';
import { parseBlocks, renderInline } from '../markdown';
import { CodeBlock } from './CodeBlock';

export interface MessageCallbacks {
  onCopy: (code: string) => void;
  onInsert: (code: string) => void;
}

/**
 * One turn.
 *
 * Memoised on the message object, so a token appended to the *last* message
 * does not re-parse and re-render every earlier one.
 */
export const ChatMessage = memo(function ChatMessage({
  message,
  callbacks
}: {
  message: MessageView;
  callbacks: MessageCallbacks;
}) {
  const blocks = useMemo(() => parseBlocks(message.text), [message.text]);

  return (
    <article
      className={`flex min-w-0 flex-col gap-1 ${
        message.role === 'user' ? 'border-l-2 border-accent pl-2' : ''
      }`}
    >
      <div className="text-2xs uppercase tracking-wider text-muted">
        {message.role === 'user' ? 'You' : 'Assistant'}
      </div>

      {blocks.map((block, index) =>
        block.kind === 'code' ? (
          <CodeBlock
            key={index}
            code={block.content}
            lang={block.lang}
            onCopy={callbacks.onCopy}
            onInsert={callbacks.onInsert}
          />
        ) : (
          <div
            key={index}
            className="min-w-0 break-words whitespace-pre-wrap"
            // Safe by construction: renderInline escapes the text before adding
            // a fixed set of tags, and never writes into an attribute.
            dangerouslySetInnerHTML={{ __html: renderInline(block.content) }}
          />
        )
      )}

      {message.streaming && (
        <span
          className="inline-block h-3 w-1.5 animate-pulse bg-ink"
          aria-label="Still writing"
        />
      )}
    </article>
  );
});
