import { Check, CircleDashed, CircleDot, LoaderCircle, Minus, X } from 'lucide-react';
import { memo } from 'react';
import { assertNever } from '../../utils/assertNever';
import type { AgentStatus, CheckState } from '../../types/view';

/**
 * State is never carried by colour alone.
 *
 * Each state has a distinct glyph as well as a hue, so it survives a
 * high-contrast theme, a monochrome display and colour blindness — and the
 * accessible name carries the same information for a screen reader.
 */
export const StatusIcon = memo(function StatusIcon({
  status,
  size = 13
}: {
  status: AgentStatus;
  size?: number;
}) {
  switch (status) {
    case 'running':
      return (
        <span
          role="img"
          aria-label="Running"
          className="inline-flex shrink-0 text-running"
        >
          <LoaderCircle size={size} className="animate-spin" aria-hidden />
        </span>
      );
    case 'completed':
      return (
        <span
          role="img"
          aria-label="Completed"
          className="inline-flex shrink-0 text-success"
        >
          <Check size={size} aria-hidden />
        </span>
      );
    case 'failed':
      return (
        <span
          role="img"
          aria-label="Failed"
          className="inline-flex shrink-0 text-danger"
        >
          <X size={size} aria-hidden />
        </span>
      );
    case 'cancelled':
      return (
        <span
          role="img"
          aria-label="Stopped"
          className="inline-flex shrink-0 text-idle"
        >
          <CircleDot size={size} aria-hidden />
        </span>
      );
    case 'waiting':
      return (
        <span
          role="img"
          aria-label="Waiting"
          className="inline-flex shrink-0 text-idle"
        >
          <CircleDashed size={size} aria-hidden />
        </span>
      );
    default:
      // A new AgentStatus must break the build here, not render nothing.
      return assertNever(status, 'StatusIcon');
  }
});

/** The same treatment for a verification check. */
export const CheckIcon = memo(function CheckIcon({ state }: { state: CheckState }) {
  switch (state) {
    case 'passed':
      return (
        <span
          role="img"
          aria-label="Passed"
          className="inline-flex shrink-0 text-success"
        >
          <Check size={12} aria-hidden />
        </span>
      );
    case 'failed':
      return (
        <span
          role="img"
          aria-label="Failed"
          className="inline-flex shrink-0 text-danger"
        >
          <X size={12} aria-hidden />
        </span>
      );
    case 'skipped':
      return (
        <span
          role="img"
          aria-label="Not run"
          className="inline-flex shrink-0 text-idle"
        >
          <Minus size={12} aria-hidden />
        </span>
      );
    case 'pending':
      return (
        <span
          role="img"
          aria-label="Pending"
          className="inline-flex shrink-0 text-idle"
        >
          <CircleDashed size={12} aria-hidden />
        </span>
      );
    default:
      return assertNever(state, 'CheckIcon');
  }
});
