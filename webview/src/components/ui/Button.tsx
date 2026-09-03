import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../utils/cn';

/**
 * The button. There is no AgentButton or TaskButton — differences that can be
 * props are props.
 *
 * Disabled and loading semantics live here so no caller reimplements them:
 * a loading button is still focusable and announces `aria-busy`, rather than
 * disappearing from the tab order mid-action.
 */
const button = cva(
  'inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-sm ' +
    'font-sans transition-colors disabled:opacity-50 disabled:cursor-default',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-ink hover:enabled:bg-accent-hover',
        secondary: 'bg-secondary text-secondary-ink hover:enabled:bg-secondary-hover',
        ghost:
          'bg-transparent text-muted hover:enabled:bg-hover hover:enabled:text-ink',
        danger: 'bg-transparent text-danger border border-danger hover:enabled:bg-hover'
      },
      size: {
        sm: 'h-5 px-1.5 text-2xs',
        md: 'h-6 px-2 text-xs'
      }
    },
    defaultVariants: { variant: 'secondary', size: 'md' }
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  children: ReactNode;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading = false, disabled, children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      className={cn(button({ variant, size }), className)}
      aria-busy={loading || undefined}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      {...rest}
    >
      {loading && <LoaderCircle size={11} className="animate-spin" aria-hidden />}
      {children}
    </button>
  );
});
