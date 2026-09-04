import { AlertTriangle, Inbox, LoaderCircle, PlugZap } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../ui/Button';

/**
 * The four states every data-driven view has to handle.
 *
 * Shared so tone and shape stay consistent, and so "nothing yet" is never
 * confused with "failed to load" — the difference decides whether someone
 * retries.
 */
export function EmptyState({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 px-2 py-8">
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-accent-tint text-accent">
        <Inbox size={18} aria-hidden />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-xl font-semibold tracking-tight text-ink">{title}</h2>
        <p className="m-0 max-w-prose text-sm text-muted">{description}</p>
      </div>
      {children}
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted" role="status">
      <LoaderCircle size={13} className="animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  retryLabel = 'Try again'
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-danger/45 bg-danger-tint px-3 py-2.5"
      role="alert"
    >
      <div className="flex items-start gap-2 text-xs text-danger">
        <AlertTriangle size={13} className="mt-px shrink-0" aria-hidden />
        <span className="wrap-break-word">{message}</span>
      </div>
      {onRetry && (
        <div>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

export function DisconnectedState({
  message,
  onReconnect
}: {
  message: string;
  onReconnect?: () => void;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-warning/45 bg-warning-tint px-3 py-2.5"
      role="status"
    >
      <div className="flex items-start gap-2 text-xs text-warning">
        <PlugZap size={13} className="mt-px shrink-0" aria-hidden />
        <span>{message}</span>
      </div>
      {onReconnect && (
        <div>
          <Button variant="secondary" size="sm" onClick={onReconnect}>
            Resync
          </Button>
        </div>
      )}
    </div>
  );
}

/** A suggestion the user can click to fill the composer. */
export function SuggestionButton({
  children,
  onClick
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-md border border-line bg-surface px-3 py-2 text-left text-xs text-ink transition-colors hover:border-accent/50 hover:bg-accent-tint"
    >
      {children}
    </button>
  );
}
