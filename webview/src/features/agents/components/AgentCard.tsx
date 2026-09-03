import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown, ChevronRight, Clock } from 'lucide-react';
import { memo, useState } from 'react';
import { formatDuration } from '../../../components/common/RelativeDuration';
import { StatusIcon } from '../../../components/ui/StatusIcon';
import type { AgentView } from '../../../types/view';

/**
 * One agent, collapsed to a line and expandable to its detail.
 *
 * Memoised individually: with five agents running, a token arriving for one
 * must not re-render the other four. That is the difference between a panel
 * that stays at 60fps under load and one that stutters.
 *
 * `variant` is not needed here — a planner and a coder differ by data, not by
 * behaviour, so one component renders both.
 */
export const AgentCard = memo(function AgentCard({ agent }: { agent: AgentView }) {
  const [open, setOpen] = useState(false);
  const expandable =
    agent.files.length > 0 || agent.tools.length > 0 || agent.error !== undefined;

  const duration =
    agent.startedAt !== undefined
      ? formatDuration((agent.finishedAt ?? Date.now()) - agent.startedAt)
      : undefined;

  const activityTone =
    agent.status === 'completed'
      ? 'text-success'
      : agent.status === 'failed'
        ? 'text-danger'
        : 'text-muted';

  return (
    <li className="border-b border-line last:border-b-0">
      <Collapsible.Root open={open} onOpenChange={setOpen} disabled={!expandable}>
        <div className="flex min-w-0 items-center gap-2 py-1 pr-2 pl-1">
          <Collapsible.Trigger
            className="flex max-w-[45%] shrink-0 items-center gap-2 rounded-sm p-1 disabled:cursor-default"
            aria-label={
              expandable
                ? `${open ? 'Collapse' : 'Expand'} ${agent.label}`
                : agent.label
            }
          >
            {expandable ? (
              open ? (
                <ChevronDown size={12} aria-hidden />
              ) : (
                <ChevronRight size={12} aria-hidden />
              )
            ) : (
              <span className="w-3" aria-hidden />
            )}
            <StatusIcon status={agent.status} />
            <span className="truncate text-xs">{agent.label}</span>
          </Collapsible.Trigger>

          <span className={`min-w-0 flex-1 truncate text-xs ${activityTone}`}>
            {agent.activity}
          </span>

          {duration !== undefined && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs tabular-nums text-muted">
              <Clock size={10} aria-hidden />
              {duration}
            </span>
          )}
        </div>

        {agent.status === 'waiting' && agent.waitedOn.length > 0 && (
          <p className="m-0 pb-1 pl-9 text-2xs text-muted">
            Waiting on {agent.waitedOn.join(', ')}
          </p>
        )}

        <Collapsible.Content>
          <dl className="m-0 grid grid-cols-[52px_1fr] gap-x-2 gap-y-1 pb-2 pl-9 pr-2 text-xs">
            {agent.files.length > 0 && (
              <>
                <dt className="text-2xs uppercase tracking-wide text-muted">Files</dt>
                <dd className="m-0 flex min-w-0 flex-wrap gap-1">
                  {agent.files.map((file) => (
                    <code key={file} className="break-all rounded-sm bg-hover px-1">
                      {file}
                    </code>
                  ))}
                </dd>
              </>
            )}
            {agent.tools.length > 0 && (
              <>
                <dt className="text-2xs uppercase tracking-wide text-muted">Tools</dt>
                <dd className="m-0 flex min-w-0 flex-wrap gap-1">
                  {agent.tools.map((tool) => (
                    <code key={tool} className="rounded-sm bg-hover px-1">
                      {tool}
                    </code>
                  ))}
                </dd>
              </>
            )}
            {agent.error !== undefined && (
              <>
                <dt className="text-2xs uppercase tracking-wide text-muted">Problem</dt>
                <dd className="m-0 break-words text-danger">{agent.error}</dd>
              </>
            )}
          </dl>
        </Collapsible.Content>
      </Collapsible.Root>
    </li>
  );
});
