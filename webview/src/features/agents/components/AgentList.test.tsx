import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { asAgentId } from '../../../../../src/events/types';
import { TooltipProvider } from '../../../components/ui/Tooltip';
import type { AgentView } from '../../../types/view';
import { AgentList } from './AgentList';

/**
 * Queried by role and accessible name rather than by test id, so the tests
 * break when a screen-reader user's experience breaks — which is the point.
 */
function makeAgent(
  overrides: Omit<Partial<AgentView>, 'id'> & { id: string }
): AgentView {
  return {
    role: 'coder',
    label: 'Coder',
    status: 'waiting',
    activity: '',
    files: [],
    tools: [],
    waitedOn: [],
    ...overrides,
    id: asAgentId(overrides.id)
  };
}

function renderList(agents: AgentView[], running = 0, done = 0) {
  return render(
    <TooltipProvider>
      <AgentList agents={agents} running={running} done={done} />
    </TooltipProvider>
  );
}

describe('AgentList', () => {
  it('shows every agent at once, whatever its state', () => {
    renderList(
      [
        makeAgent({
          id: 'a',
          label: 'Repository',
          status: 'completed',
          activity: 'Done'
        }),
        makeAgent({
          id: 'b',
          label: 'Backend',
          status: 'running',
          activity: 'Editing auth.ts'
        }),
        makeAgent({
          id: 'c',
          label: 'Verification',
          status: 'waiting',
          activity: 'Queued'
        })
      ],
      1,
      1
    );

    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('Repository')).toBeInTheDocument();
    expect(screen.getByText('Editing auth.ts')).toBeInTheDocument();
  });

  it('conveys status by name, not by colour alone', () => {
    renderList([
      makeAgent({ id: 'a', label: 'Done one', status: 'completed' }),
      makeAgent({ id: 'b', label: 'Failed one', status: 'failed' }),
      makeAgent({ id: 'c', label: 'Busy one', status: 'running' })
    ]);

    expect(screen.getByLabelText('Completed')).toBeInTheDocument();
    expect(screen.getByLabelText('Failed')).toBeInTheDocument();
    expect(screen.getByLabelText('Running')).toBeInTheDocument();
  });

  it('explains why an agent is waiting', () => {
    renderList([
      makeAgent({
        id: 'b',
        label: 'Tests',
        status: 'waiting',
        waitedOn: ['implement-1']
      })
    ]);
    expect(screen.getByText(/queued behind implement-1/)).toBeInTheDocument();
  });

  it('expands detail from the keyboard', async () => {
    const user = userEvent.setup();
    renderList([
      makeAgent({
        id: 'a',
        label: 'Backend',
        status: 'running',
        files: ['src/auth.ts'],
        tools: ['apply_patch']
      })
    ]);

    const toggle = screen.getByRole('button', { name: /Expand Backend/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.tab();
    await user.keyboard('{Enter}');

    expect(screen.getByText('src/auth.ts')).toBeInTheDocument();
    expect(screen.getByText('apply_patch')).toBeInTheDocument();
  });

  it('does not offer expansion for an agent with no detail', () => {
    renderList([makeAgent({ id: 'a', label: 'Idle', status: 'waiting' })]);
    expect(screen.getByRole('button', { name: 'Idle' })).toBeDisabled();
  });

  it('renders nothing when there are no agents', () => {
    const { container } = renderList([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('has no detectable accessibility violations', async () => {
    const { container } = renderList(
      [
        makeAgent({
          id: 'a',
          label: 'Repository',
          status: 'completed',
          activity: 'Done'
        }),
        makeAgent({
          id: 'b',
          label: 'Backend',
          status: 'failed',
          activity: 'patch did not match',
          error: 'patch did not match'
        })
      ],
      0,
      1
    );

    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
