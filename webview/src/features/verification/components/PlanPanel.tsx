import { memo } from 'react';
import { Badge } from '../../../components/ui/Badge';
import { Panel, PanelHeading } from '../../../components/ui/Panel';
import type { PlanView } from '../../../types/view';

export const PlanPanel = memo(function PlanPanel({ plan }: { plan: PlanView }) {
  const settled = plan.completed.length + plan.failed.length;

  return (
    <Panel label="Planning">
      <PanelHeading
        meta={
          plan.status === 'running'
            ? `${settled}/${plan.planners.length} analysed`
            : `${plan.changes} change(s)`
        }
      >
        Plan
      </PanelHeading>

      {plan.status === 'done' && (
        <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-xs text-muted">
          <span>{plan.files} file(s) relevant</span>
          <span>{plan.changes} to change</span>
          {plan.conflicts > 0 && (
            <Badge tone="warning">{plan.conflicts} disagreement(s)</Badge>
          )}
          <span className="flex-1" />
          <span title="Mean confidence reported by the planners">
            confidence {Math.round(plan.confidence * 100)}%
          </span>
        </div>
      )}

      {plan.failed.length > 0 && (
        <p className="m-0 px-2 pb-1.5 text-xs text-warning">
          Incomplete analysis: {plan.failed.join(', ')} did not report.
        </p>
      )}
    </Panel>
  );
});
