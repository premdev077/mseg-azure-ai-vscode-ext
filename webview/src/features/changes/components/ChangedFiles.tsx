import { useMemo } from 'react';
import { host } from '../../../services/vscode';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../store/appStore';
import { selectChanges, selectChangeSummary } from '../../../store/selectors/changes';
import { ChangedFilesList, type ChangedFilesCallbacks } from './ChangedFilesList';

export function ChangedFiles() {
  const changes = useAppStore(useShallow((s) => selectChanges(s.app)));
  const summary = useAppStore(useShallow((s) => selectChangeSummary(s.app)));

  // Stable identity so memoised rows are not invalidated every render.
  const callbacks = useMemo<ChangedFilesCallbacks>(
    () => ({
      onOpen: host.openFile,
      onViewDiff: host.openDiff,
      onAccept: host.acceptEdit,
      onReject: host.rejectEdit
    }),
    []
  );

  return <ChangedFilesList changes={changes} summary={summary} callbacks={callbacks} />;
}
