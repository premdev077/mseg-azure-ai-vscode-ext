import type { ReactNode } from 'react';
import { cn } from '../../utils/cn';

/** A bordered region with a heading. Flat by design: this is not a dashboard. */
export function Panel({
  children,
  className,
  label
}: {
  children: ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        'overflow-hidden rounded-sm border border-line bg-surface',
        className
      )}
    >
      {children}
    </section>
  );
}

export function PanelHeading({
  children,
  meta,
  icon
}: {
  children: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-2 py-1.5 text-2xs uppercase tracking-wider text-muted">
      {icon}
      <span>{children}</span>
      <span className="flex-1" />
      {meta && <span className="tabular-nums normal-case tracking-normal">{meta}</span>}
    </div>
  );
}
