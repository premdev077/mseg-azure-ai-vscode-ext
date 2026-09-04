import type { ReactNode } from 'react';
import { cn } from '../../utils/cn';

/**
 * A grouped region.
 *
 * `tone` tints the whole panel so a verdict reads at a glance — a passing
 * verification should be recognisable before a word of it is read. Everything
 * else stays neutral, because a panel that shouts when it has nothing to say
 * trains people to ignore the ones that do.
 */
export type PanelTone = 'neutral' | 'success' | 'danger' | 'active';

const TONE_RING: Record<PanelTone, string> = {
  neutral: 'border-line',
  success: 'border-success/45',
  danger: 'border-danger/45',
  active: 'border-accent/40'
};

export function Panel({
  children,
  className,
  label,
  tone = 'neutral'
}: {
  children: ReactNode;
  className?: string;
  label: string;
  tone?: PanelTone;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        'overflow-hidden rounded-md border bg-surface',
        TONE_RING[tone],
        className
      )}
    >
      {children}
    </section>
  );
}

const TONE_HEAD: Record<PanelTone, string> = {
  neutral: 'bg-raise text-ink',
  success: 'bg-success-tint text-success',
  danger: 'bg-danger-tint text-danger',
  active: 'bg-accent-tint text-ink'
};

/**
 * A panel heading.
 *
 * Sentence case at a readable size, not shouty uppercase micro-text: the
 * previous treatment was small and grey enough that five stacked panels read
 * as one undifferentiated block.
 */
export function PanelHeading({
  children,
  meta,
  icon,
  tone = 'neutral'
}: {
  children: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
  tone?: PanelTone;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 border-b border-line px-3 py-2 text-xs font-semibold',
        TONE_HEAD[tone]
      )}
    >
      {icon && <span className="shrink-0 opacity-80">{icon}</span>}
      <span className="tracking-tight">{children}</span>
      <span className="flex-1" />
      {meta && (
        <span className="text-2xs font-normal tabular-nums opacity-75">{meta}</span>
      )}
    </div>
  );
}

/**
 * A thin completion bar.
 *
 * Progress across parallel agents is the one number worth showing as a shape —
 * "4 of 7" is a fact, but a bar is a glance.
 */
export function ProgressRail({
  value,
  total,
  tone = 'active'
}: {
  value: number;
  total: number;
  tone?: 'active' | 'success';
}) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div
      className="h-0.5 w-full bg-line"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={`${value} of ${total} complete`}
    >
      <div
        className={cn(
          'h-full transition-all duration-300',
          tone === 'success' ? 'bg-success' : 'bg-accent'
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
