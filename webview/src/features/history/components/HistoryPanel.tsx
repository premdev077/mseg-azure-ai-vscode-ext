import { Trash2, X } from 'lucide-react';
import { EmptyState, LoadingState } from '../../../components/common/States';
import { IconButton } from '../../../components/ui/IconButton';
import { PanelHeading } from '../../../components/ui/Panel';
import { host } from '../../../services/vscode';
import { useAppStore } from '../../../store/appStore';

export function HistoryPanel() {
  const open = useAppStore((s) => s.historyOpen);
  const loading = useAppStore((s) => s.historyLoading);
  const conversations = useAppStore((s) => s.conversations);
  const setOpen = useAppStore((s) => s.setHistoryOpen);

  if (!open) {
    return null;
  }

  const close = (): void => {
    setOpen(false);
    host.closeHistory();
  };

  return (
    <aside
      aria-label="Conversation history"
      className="max-h-2/5 shrink-0 overflow-y-auto border-b border-line bg-surface"
    >
      <PanelHeading
        meta={
          <IconButton
            icon={<X size={12} aria-hidden />}
            label="Close history"
            onClick={close}
          />
        }
      >
        History
      </PanelHeading>

      {loading ? (
        <LoadingState label="Loading saved conversations…" />
      ) : conversations.length === 0 ? (
        <EmptyState
          title="No saved conversations"
          description="Conversations you have are saved here so you can reopen and continue them."
        />
      ) : (
        <ul className="m-0 list-none p-0">
          {conversations.map((conversation) => (
            <li
              key={conversation.id}
              className="flex items-center border-b border-line"
            >
              <button
                type="button"
                title={conversation.workspace}
                onClick={() => host.loadConversation(conversation.id)}
                className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-px border-0 bg-transparent px-2 py-1.5 text-left text-inherit hover:bg-hover"
              >
                <span className="max-w-full truncate text-xs">
                  {conversation.title}
                </span>
                <span className="text-2xs text-muted">
                  {new Date(conversation.updatedAt).toLocaleString()}
                </span>
              </button>
              <IconButton
                icon={<Trash2 size={11} aria-hidden />}
                label={`Delete ${conversation.title}`}
                onClick={() => host.deleteConversation(conversation.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
