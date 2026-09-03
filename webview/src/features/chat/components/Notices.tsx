import { X } from 'lucide-react';
import { IconButton } from '../../../components/ui/IconButton';
import { useAppStore } from '../../../store/appStore';

export function Notices() {
  const notices = useAppStore((s) => s.app.stream.notices);
  const dismiss = useAppStore((s) => s.dismissNotice);

  if (notices.length === 0) {
    return null;
  }

  return (
    <ul className="m-0 shrink-0 list-none p-0">
      {notices.map((notice) => (
        <li
          key={notice.id}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`flex items-start gap-1.5 border-b border-line bg-surface px-2 py-1.5 text-xs ${
            notice.kind === 'error'
              ? 'border-l-2 border-l-danger text-danger'
              : 'border-l-2 border-l-running'
          }`}
        >
          <span className="min-w-0 flex-1 break-words">{notice.text}</span>
          <IconButton
            icon={<X size={11} aria-hidden />}
            label="Dismiss"
            onClick={() => dismiss(notice.id)}
          />
        </li>
      ))}
    </ul>
  );
}
