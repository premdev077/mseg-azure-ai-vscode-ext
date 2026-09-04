import { Sparkles, User } from 'lucide-react';
import { memo, useMemo } from 'react';
import { cn } from '../../../utils/cn';
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
 * The two roles are told apart by shape, not just a label: what you asked sits
 * in a tinted block with a clear edge, what the assistant said runs full width
 * as prose. A grey caption over identical blocks made a long transcript hard
 * to skim.
 *
 * Memoised on the message, so a token appended to the last one does not
 * re-parse every earlier message.
 */
export const ChatMessage = memo(function ChatMessage({
  message,
  callbacks
}: {
  message: MessageView;
  callbacks: MessageCallbacks;
}) {
  const blocks = useMemo(() => parseBlocks(message.text), [message.text]);
  const isUser = message.role === 'user';

  return (
    <article className={cn('flex min-w-0 flex-col gap-1.5', isUser && 'items-stretch')}>
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            'inline-flex h-4 w-4 items-center justify-center rounded-full',
            isUser ? 'bg-accent text-accent-ink' : 'bg-raise text-muted'
          )}
          aria-hidden
        >
          {isUser ? <User size={9} /> : <Sparkles size={9} />}
        </span>
        <span className="text-2xs font-semibold tracking-wide text-muted">
          {isUser ? 'You' : 'Assistant'}
        </span>
      </div>

      <div
        className={cn(
          'flex min-w-0 flex-col gap-2 text-sm leading-relaxed',
          isUser && 'rounded-md border-l-2 border-accent bg-accent-tint px-3 py-2'
        )}
      >
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
              className="min-w-0 wrap-break-word whitespace-pre-wrap"
              // Safe by construction: renderInline escapes the text before
              // adding a fixed set of tags, and never writes into an attribute.
              dangerouslySetInnerHTML={{ __html: renderInline(block.content) }}
            />
          )
        )}

        {message.streaming && (
          <span
            className="inline-block h-3.5 w-1.5 animate-pulse rounded-xs bg-accent align-text-bottom"
            aria-label="Still writing"
          />
        )}
      </div>
    </article>
  );
});
