import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactElement, ReactNode } from 'react';

/**
 * Tooltips through Radix rather than the `title` attribute.
 *
 * `title` is not keyboard-reachable and cannot be styled to match the theme;
 * Radix handles focus, escape, pointer and screen-reader behaviour so no
 * caller has to.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </RadixTooltip.Provider>
  );
}

export function Tooltip({
  content,
  children
}: {
  content: ReactNode;
  children: ReactElement;
}) {
  if (!content) {
    return children;
  }
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side="top"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 max-w-64 rounded-sm border border-line bg-surface px-2 py-1 text-2xs text-ink shadow-sm"
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
