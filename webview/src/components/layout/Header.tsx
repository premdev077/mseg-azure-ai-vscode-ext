import { History, Plus, Settings } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { IconButton } from '../ui/IconButton';
import { StatusIcon } from '../ui/StatusIcon';
import type { ConnectionState } from '../../types/view';

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  live: 'Connected',
  'catching-up': 'Catching up',
  degraded: 'Incomplete',
  lost: 'Disconnected'
};

const CONNECTION_TONE: Record<ConnectionState, string> = {
  connecting: 'bg-running animate-pulse',
  live: 'bg-success',
  'catching-up': 'bg-warning animate-pulse',
  degraded: 'bg-warning',
  lost: 'bg-danger'
};

export interface HeaderProps {
  phaseLabel: string;
  busy: boolean;
  connection: ConnectionState;
  multiAgent: boolean;
  onNewChat: () => void;
  onHistory: () => void;
  onSettings: () => void;
}

export function Header({
  phaseLabel,
  busy,
  connection,
  multiAgent,
  onNewChat,
  onHistory,
  onSettings
}: HeaderProps) {
  return (
    <header className="flex min-h-8 shrink-0 items-center gap-1.5 border-b border-line bg-canvas px-2 py-1.5">
      <span className="hidden text-xs font-semibold tracking-wide text-muted uppercase sm:inline">
        AI Coding Assistant
      </span>

      <span
        className="inline-flex min-w-0 items-center gap-1 truncate text-xs"
        role="status"
        aria-live="polite"
      >
        {busy && <StatusIcon status="running" size={11} />}
        {phaseLabel}
      </span>

      <span className="flex-1" />

      {multiAgent && <Badge tone="accent">multi-agent</Badge>}

      <span
        className="inline-flex items-center gap-1 text-2xs whitespace-nowrap text-muted"
        title={CONNECTION_LABEL[connection]}
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${CONNECTION_TONE[connection]}`}
          aria-hidden
        />
        <span className="hidden sm:inline">{CONNECTION_LABEL[connection]}</span>
      </span>

      <IconButton
        icon={<Plus size={13} aria-hidden />}
        label="New chat"
        onClick={onNewChat}
      />
      <IconButton
        icon={<History size={13} aria-hidden />}
        label="History"
        onClick={onHistory}
      />
      <IconButton
        icon={<Settings size={13} aria-hidden />}
        label="Settings"
        onClick={onSettings}
      />
    </header>
  );
}
