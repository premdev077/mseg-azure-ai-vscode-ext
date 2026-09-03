import { ShieldCheck } from 'lucide-react';
import { memo } from 'react';
import { Badge } from '../../../components/ui/Badge';
import { Panel, PanelHeading } from '../../../components/ui/Panel';
import { CheckIcon, StatusIcon } from '../../../components/ui/StatusIcon';
import type { VerificationView } from '../../../types/view';

/**
 * The quality gate, rendered.
 *
 * Each check is shown separately and a skipped check renders as a dash rather
 * than a tick — "the project has no tests" must never look like "the tests
 * passed".
 */
export const VerificationPanel = memo(function VerificationPanel({
  verification
}: {
  verification: VerificationView;
}) {
  const { status } = verification;
  const border =
    status === 'passed'
      ? 'border-success'
      : status === 'failed'
        ? 'border-danger'
        : 'border-line';

  return (
    <Panel label="Verification" className={border}>
      <PanelHeading
        icon={<ShieldCheck size={13} aria-hidden />}
        meta={status === 'running' ? `attempt ${verification.attempt}` : undefined}
      >
        Verification
      </PanelHeading>

      <ul className="m-0 grid list-none gap-1 p-2 text-xs">
        <li className="flex items-center gap-2">
          <CheckIcon state={verification.typecheck} /> Type check
        </li>
        <li className="flex items-center gap-2">
          <CheckIcon state={verification.lint} /> Lint
        </li>
        <li className="flex items-center gap-2">
          <CheckIcon state={verification.tests} /> Tests
        </li>
        <li className="flex items-center gap-2">
          <CheckIcon state={verification.build} /> Build
        </li>
      </ul>

      <div className="flex items-center gap-2 border-t border-line px-2 py-1.5 text-xs">
        {status === 'running' && (
          <>
            <StatusIcon status="running" />
            <span>Checking the work independently…</span>
          </>
        )}
        {status === 'passed' && <Badge tone="success">VERIFIED</Badge>}
        {status === 'failed' && (
          <>
            <Badge tone="danger">NOT VERIFIED</Badge>
            {verification.issues > 0 && (
              <span className="text-2xs text-muted">
                {verification.issues} issue(s), {verification.fixes} fix(es) requested
              </span>
            )}
          </>
        )}
      </div>
    </Panel>
  );
});
