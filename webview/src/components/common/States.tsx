import { AlertTriangle, Inbox, LoaderCircle, PlugZap } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../ui/Button';

/**
 * The four states every data-driven view has to handle.
 *
 * Shared so the tone and shape stay consistent, and so "no data yet" is never
 * confused with "failed to load" — the difference matters to whoever is
 * deciding whether to retry.
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
    <div className="px-2 py-6 text-muted">
      <Inbox size={20} aria-hidden />
      <h2 className="mt-2 mb-1 text-lg text-ink">{title}</h2>
      <p className="mb-2 text-sm">{description}</p>
      {children}
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted" role="status">
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
      className="flex flex-col gap-2 border-l-2 border-danger bg-surface px-2 py-2"
      role="alert"
    >
      <div className="flex items-start gap-2 text-sm text-danger">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
        <span className="break-words">{message}</span>
      </div>
      {onRetry && (
        <div>
          <Button variant="secondary" onClick={onRetry}>
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
      className="flex flex-col gap-2 border-l-2 border-warning bg-surface px-2 py-2"
      role="status"
    >
      <div className="flex items-start gap-2 text-sm text-warning">
        <PlugZap size={13} className="mt-0.5 shrink-0" aria-hidden />
        <span>{message}</span>
      </div>
      {onReconnect && (
        <div>
          <Button variant="secondary" onClick={onReconnect}>
            Resync
          </Button>
        </div>
      )}
    </div>
  );
}
