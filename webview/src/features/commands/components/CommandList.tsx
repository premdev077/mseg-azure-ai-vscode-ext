import { Ban, Play, Terminal } from 'lucide-react';
import { memo, useMemo } from 'react';
import { formatDuration } from '../../../components/common/RelativeDuration';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { Panel, PanelHeading } from '../../../components/ui/Panel';
import { host } from '../../../services/vscode';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../store/appStore';
import { selectVisibleCommands } from '../../../store/selectors/commands';
import type { CommandView } from '../../../types/view';

interface Callbacks {
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

const CommandRow = memo(function CommandRow({
  command,
  callbacks
}: {
  command: CommandView;
  callbacks: Callbacks;
}) {
  return (
    <li className="flex flex-col gap-1 border-b border-line px-2 py-1.5 last:border-b-0">
      <code className="overflow-x-auto whitespace-pre rounded-sm bg-sunken px-1.5 py-1 text-xs">
        {command.command}
      </code>

      {command.status === 'pending' ? (
        <>
          <p className="m-0 text-2xs text-muted">{command.reason}</p>
          <span className="flex gap-1">
            <Button
              variant="primary"
              size="sm"
              onClick={() => callbacks.onApprove(command.id)}
            >
              <Play size={11} aria-hidden /> Run
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => callbacks.onReject(command.id)}
            >
              <Ban size={11} aria-hidden /> Skip
            </Button>
          </span>
        </>
      ) : (
        <span className="flex items-center gap-2 text-2xs">
          {command.status === 'rejected' && <Badge tone="neutral">skipped</Badge>}
          {command.status === 'finished' && (
            <Badge tone={command.exitCode === 0 ? 'success' : 'danger'}>
              exit {command.exitCode ?? '?'}
            </Badge>
          )}
          {command.durationMs !== undefined && (
            <span className="text-muted">{formatDuration(command.durationMs)}</span>
          )}
        </span>
      )}
    </li>
  );
});

export function CommandList() {
  const commands = useAppStore(useShallow((s) => selectVisibleCommands(s.app)));
  const callbacks = useMemo<Callbacks>(
    () => ({ onApprove: host.approveCommand, onReject: host.rejectCommand }),
    []
  );

  if (commands.length === 0) {
    return null;
  }

  return (
    <Panel label="Commands">
      <PanelHeading icon={<Terminal size={13} aria-hidden />}>Commands</PanelHeading>
      <ul className="m-0 list-none p-0">
        {commands.map((command) => (
          <CommandRow key={command.id} command={command} callbacks={callbacks} />
        ))}
      </ul>
    </Panel>
  );
}
