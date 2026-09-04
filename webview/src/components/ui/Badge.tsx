import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactNode } from 'react';
import { cn } from '../../utils/cn';

const badge = cva(
  'inline-flex h-4.5 items-center whitespace-nowrap rounded-full border px-2 ' +
    'text-2xs font-semibold tracking-tight',
  {
    variants: {
      tone: {
        neutral: 'border-current text-muted',
        success: 'border-current text-success',
        warning: 'border-current text-warning',
        danger: 'border-current text-danger',
        accent: 'border-current text-link'
      }
    },
    defaultVariants: { tone: 'neutral' }
  }
);

export function Badge({
  children,
  tone,
  className
}: VariantProps<typeof badge> & { children: ReactNode; className?: string }) {
  return <span className={cn(badge({ tone }), className)}>{children}</span>;
}
