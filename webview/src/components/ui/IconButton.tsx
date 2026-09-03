import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../utils/cn';
import { Tooltip } from './Tooltip';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label'
> {
  icon: ReactNode;
  /** Required: an icon with no accessible name is invisible to a screen reader. */
  label: string;
}

/**
 * An icon-only control.
 *
 * The label is mandatory and serves twice — as the accessible name and as the
 * tooltip — so the two can never drift apart.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ icon, label, className, ...rest }, ref) {
    return (
      <Tooltip content={label}>
        <button
          ref={ref}
          type="button"
          aria-label={label}
          className={cn(
            'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm',
            'bg-transparent text-muted transition-colors',
            'hover:enabled:bg-hover hover:enabled:text-ink disabled:opacity-50',
            className
          )}
          {...rest}
        >
          {icon}
        </button>
      </Tooltip>
    );
  }
);
