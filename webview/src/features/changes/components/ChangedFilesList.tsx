import { FileDiff } from 'lucide-react';
import { memo } from 'react';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { IconButton } from '../../../components/ui/IconButton';
import { Panel, PanelHeading } from '../../../components/ui/Panel';
import type { ChangeView } from '../../../types/view';

export interface ChangedFilesCallbacks {
  onOpen: (relPath: string) => void;
  onViewDiff: (editId: string) => void;
  onAccept: (editId: string) => void;
  onReject: (editId: string) => void;
}

const ChangeRow = memo(function ChangeRow({
  change,
  callbacks
}: {
  change: ChangeView;
  callbacks: ChangedFilesCallbacks;
}) {
  const letter = change.isNewFile ? 'A' : 'M';
  const awaitingReview = change.status === 'proposed' && change.editId !== undefined;
  const struck = change.status === 'rejected' || change.status === 'expired';

  return (
    <li className="flex min-w-0 items-center gap-2 border-b border-line px-2 py-1 last:border-b-0">
      <span
        className={`w-3 shrink-0 font-mono text-xs font-bold ${
          change.isNewFile ? 'text-added' : 'text-modified'
        }`}
        aria-label={change.isNewFile ? 'Added' : 'Modified'}
      >
        {letter}
      </span>

      <button
        type="button"
        onClick={() => callbacks.onOpen(change.relPath)}
        title={`Open ${change.relPath}`}
        className={`truncate-start min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-xs text-inherit hover:text-link hover:underline ${
          struck ? 'text-muted line-through' : ''
        }`}
      >
        {change.relPath}
      </button>

      <span className="shrink-0 font-mono text-2xs tabular-nums">
        <span className="text-added">+{change.added}</span>{' '}
        <span className="text-removed">−{change.removed}</span>
      </span>

      {awaitingReview && change.editId !== undefined ? (
        <span className="flex shrink-0 items-center gap-1">
          <IconButton
            icon={<FileDiff size={12} aria-hidden />}
            label={`View diff for ${change.relPath}`}
            onClick={() => callbacks.onViewDiff(change.editId as string)}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => callbacks.onAccept(change.editId as string)}
          >
            Accept
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => callbacks.onReject(change.editId as string)}
          >
            Reject
          </Button>
        </span>
      ) : (
        <span className="shrink-0">
          {change.status === 'accepted' && <Badge tone="success">applied</Badge>}
          {change.status === 'rejected' && <Badge tone="danger">rejected</Badge>}
          {change.status === 'expired' && <Badge tone="neutral">expired</Badge>}
        </span>
      )}
    </li>
  );
});

/**
 * Files the run touched.
 *
 * Rejected and expired rows stay: an edit the user refused is information, and
 * dropping it makes a declined change look like it never happened.
 */
export const ChangedFilesList = memo(function ChangedFilesList({
  changes,
  summary,
  callbacks
}: {
  changes: readonly ChangeView[];
  summary: { files: number; added: number; removed: number };
  callbacks: ChangedFilesCallbacks;
}) {
  if (changes.length === 0) {
    return null;
  }

  return (
    <Panel label="Changed files">
      <PanelHeading
        meta={
          <>
            {summary.files} file(s) <span className="text-added">+{summary.added}</span>{' '}
            <span className="text-removed">−{summary.removed}</span>
          </>
        }
      >
        Changes
      </PanelHeading>
      <ul className="m-0 list-none p-0">
        {changes.map((change) => (
          <ChangeRow key={change.relPath} change={change} callbacks={callbacks} />
        ))}
      </ul>
    </Panel>
  );
});
