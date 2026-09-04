import { ShieldCheck } from 'lucide-react';
import { memo } from 'react';
import { Panel, PanelHeading } from '../../../components/ui/Panel';
import { CheckIcon, StatusIcon } from '../../../components/ui/StatusIcon';
import { cn } from '../../../utils/cn';
import type { CheckState, VerificationView } from '../../../types/view';

/**
 * The quality gate.
 *
 * This is the payoff of a run, so it is allowed to be the loudest thing on
 * screen — a passing verdict is green, a failing one red, and neither is
 * mistakable for the other at a glance. A skipped check renders as a dash,
 * never a tick: "this project has no tests" must never look like "the tests
 * passed".
 */
const CHECKS: ReadonlyArray<{ key: keyof VerificationView; label: string }> = [
  { key: 'typecheck', label: 'Type check' },
  { key: 'lint', label: 'Lint' },
  { key: 'tests', label: 'Tests' },
  { key: 'build', label: 'Build' }
];

export const VerificationPanel = memo(function VerificationPanel({
  verification
}: {
  verification: VerificationView;
}) {
  const { status } = verification;
  const tone =
    status === 'passed' ? 'success' : status === 'failed' ? 'danger' : 'active';

  return (
    <Panel label="Verification" tone={tone}>
      <PanelHeading
        tone={tone}
        icon={<ShieldCheck size={13} aria-hidden />}
        meta={status === 'running' ? `attempt ${verification.attempt}` : undefined}
      >
        {status === 'passed'
          ? 'Verified'
          : status === 'failed'
            ? 'Not verified'
            : 'Verifying'}
      </PanelHeading>

      <ul className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-1.5 p-3 text-xs">
        {CHECKS.map(({ key, label }) => {
          const state = verification[key] as CheckState;
          return (
            <li key={key} className="flex items-center gap-2">
              <CheckIcon state={state} />
              <span className={cn(state === 'skipped' && 'text-muted')}>{label}</span>
            </li>
          );
        })}
      </ul>

      {status === 'running' && (
        <div className="flex items-center gap-2 border-t border-line px-3 py-2 text-xs text-muted">
          <StatusIcon status="running" size={12} />
          Checking the work independently…
        </div>
      )}

      {status === 'failed' && verification.issues > 0 && (
        <p className="m-0 border-t border-line px-3 py-2 text-xs text-danger">
          {verification.issues} issue{verification.issues === 1 ? '' : 's'} found ·{' '}
          {verification.fixes} fix{verification.fixes === 1 ? '' : 'es'} requested
        </p>
      )}
    </Panel>
  );
});
