import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown, ChevronRight, ListChecks } from 'lucide-react';
import { memo, useState } from 'react';
import { StatusIcon } from '../../../components/ui/StatusIcon';
import { MAX_TOOL_ROWS } from '../../../constants/limits';
import { useAppStore } from '../../../store/appStore';
import { describeTool } from '../../../store/slices/streamSlice';
import type { ToolView } from '../../../types/view';

const ToolRow = memo(function ToolRow({ tool }: { tool: ToolView }) {
  return (
    <li className="flex min-w-0 items-baseline gap-2 px-3 py-1 text-xs">
      <StatusIcon
        size={11}
        status={
          tool.status === 'running'
            ? 'running'
            : tool.status === 'error'
              ? 'failed'
              : 'completed'
        }
      />
      <span className="max-w-[55%] shrink-0 truncate">
        {describeTool(tool.name, tool.args)}
      </span>
      {tool.preview !== undefined && tool.preview.length > 0 && (
        <span
          className={`min-w-0 flex-1 truncate text-2xs ${
            tool.status === 'error' ? 'text-danger' : 'text-muted'
          }`}
        >
          {tool.preview}
        </span>
      )}
    </li>
  );
});

/**
 * Recent tool calls.
 *
 * Windowed rather than virtualised: only the tail is meaningful and nobody
 * scrolls back through it, so a fixed window keeps the DOM small without
 * pulling in a windowing library for a list that does not need one.
 */
export function ToolActivity() {
  const tools = useAppStore((s) => s.app.stream.tools);
  const [open, setOpen] = useState(false);

  if (tools.length === 0) {
    return null;
  }

  const shown = tools.slice(-MAX_TOOL_ROWS);
  const hidden = tools.length - shown.length;

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className="overflow-hidden rounded-md border border-line bg-surface"
    >
      <Collapsible.Trigger className="flex w-full items-center gap-2 bg-raise px-3 py-2 text-xs font-semibold text-ink transition-colors hover:bg-hover">
        {open ? (
          <ChevronDown size={12} className="text-muted" aria-hidden />
        ) : (
          <ChevronRight size={12} className="text-muted" aria-hidden />
        )}
        <ListChecks size={13} className="opacity-80" aria-hidden />
        <span className="tracking-tight">Activity</span>
        <span className="flex-1" />
        <span className="text-2xs font-normal tabular-nums opacity-75">
          {tools.length} step{tools.length === 1 ? '' : 's'}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div className="border-t border-line py-1.5">
          {hidden > 0 && (
            <p className="m-0 px-3 py-1 text-2xs text-muted">
              {hidden} earlier step(s) not shown
            </p>
          )}
          <ul className="m-0 list-none p-0">
            {shown.map((tool) => (
              <ToolRow key={tool.id} tool={tool} />
            ))}
          </ul>
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
