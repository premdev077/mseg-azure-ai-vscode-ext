import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { memo, useState } from 'react';
import { formatDuration } from '../../../components/common/RelativeDuration';
import { StatusIcon } from '../../../components/ui/StatusIcon';
import { cn } from '../../../utils/cn';
import type { AgentStatus, AgentView } from '../../../types/view';

/**
 * One agent.
 *
 * A running agent carries an accent rail and a lifted surface, so which of
 * five agents is live reads before any text is. Finished agents recede rather
 * than disappear — the point of the panel is that you can see the whole shape
 * of the run, not just its leading edge.
 *
 * Memoised individually: with several agents working, a token for one must not
 * re-render the rest.
 */
const ROW_TONE: Record<AgentStatus, string> = {
  running: 'bg-running-tint',
  waiting: '',
  completed: '',
  failed: 'bg-danger-tint',
  cancelled: ''
};

const RAIL_TONE: Record<AgentStatus, string> = {
  running: 'bg-running',
  waiting: 'bg-transparent',
  completed: 'bg-success/50',
  failed: 'bg-danger',
  cancelled: 'bg-idle/40'
};

const ACTIVITY_TONE: Record<AgentStatus, string> = {
  running: 'text-ink',
  waiting: 'text-muted',
  completed: 'text-muted',
  failed: 'text-danger',
  cancelled: 'text-muted'
};

export const AgentCard = memo(function AgentCard({ agent }: { agent: AgentView }) {
  const [open, setOpen] = useState(false);
  const expandable =
    agent.files.length > 0 || agent.tools.length > 0 || agent.error !== undefined;

  const duration =
    agent.startedAt !== undefined
      ? formatDuration((agent.finishedAt ?? Date.now()) - agent.startedAt)
      : undefined;

  return (
    <li
      className={cn(
        'relative border-b border-line/60 last:border-b-0',
        ROW_TONE[agent.status]
      )}
    >
      {/* The rail carries state without spending a whole row on it. */}
      <span
        aria-hidden
        className={cn('absolute inset-y-0 left-0 w-0.5', RAIL_TONE[agent.status])}
      />

      <Collapsible.Root open={open} onOpenChange={setOpen} disabled={!expandable}>
        <div className="flex min-w-0 items-center gap-2 py-2 pr-3 pl-2.5">
          <Collapsible.Trigger
            className={cn(
              'group flex min-w-0 shrink-0 items-center gap-2 rounded-sm text-left',
              expandable ? 'cursor-pointer' : 'cursor-default'
            )}
            aria-label={
              expandable
                ? `${open ? 'Collapse' : 'Expand'} ${agent.label}`
                : agent.label
            }
          >
            {expandable ? (
              open ? (
                <ChevronDown size={12} className="shrink-0 text-muted" aria-hidden />
              ) : (
                <ChevronRight size={12} className="shrink-0 text-muted" aria-hidden />
              )
            ) : (
              <span className="w-3 shrink-0" aria-hidden />
            )}
            <StatusIcon status={agent.status} size={14} />
            <span
              className={cn(
                'truncate text-sm',
                agent.status === 'running' ? 'font-semibold text-ink' : 'font-medium',
                agent.status === 'cancelled' && 'text-muted',
                expandable && 'group-hover:text-link'
              )}
            >
              {agent.label}
            </span>
          </Collapsible.Trigger>

          <span
            className={cn(
              'min-w-0 flex-1 truncate text-xs',
              ACTIVITY_TONE[agent.status]
            )}
            title={agent.activity}
          >
            {agent.activity}
          </span>

          {duration !== undefined && (
            <span className="shrink-0 font-mono text-2xs tabular-nums text-muted">
              {duration}
            </span>
          )}
        </div>

        {agent.status === 'waiting' && agent.waitedOn.length > 0 && (
          <p className="m-0 pb-2 pl-10 text-2xs text-muted">
            queued behind {agent.waitedOn.join(', ')}
          </p>
        )}

        <Collapsible.Content>
          <div className="flex flex-col gap-2 border-t border-line/60 bg-canvas/40 px-3 py-2.5 pl-10">
            {agent.files.length > 0 && (
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-2xs font-medium tracking-wide text-muted uppercase">
                  Files
                </span>
                <div className="flex flex-wrap gap-1">
                  {agent.files.map((file) => (
                    <code
                      key={file}
                      className="rounded-sm bg-raise px-1.5 py-0.5 text-2xs break-all"
                    >
                      {file}
                    </code>
                  ))}
                </div>
              </div>
            )}

            {agent.tools.length > 0 && (
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-2xs font-medium tracking-wide text-muted uppercase">
                  Tools
                </span>
                <div className="flex flex-wrap gap-1">
                  {agent.tools.map((tool) => (
                    <code
                      key={tool}
                      className="rounded-sm bg-raise px-1.5 py-0.5 text-2xs"
                    >
                      {tool}
                    </code>
                  ))}
                </div>
              </div>
            )}

            {agent.error !== undefined && (
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-2xs font-medium tracking-wide text-danger uppercase">
                  Problem
                </span>
                <p className="m-0 text-xs wrap-break-word text-danger">{agent.error}</p>
              </div>
            )}
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </li>
  );
});
