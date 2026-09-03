import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../components/ui/Tooltip';
import { AgentActivity } from '../features/agents';
import { ChangedFiles } from '../features/changes';
import { CommandList } from '../features/commands';
import { useAppStore } from '../store/appStore';
import { initialAppState, processEvents } from '../store/processEvent';
import { makeEvent, resetSequence } from '../test/factories';

/**
 * Containers rendered against the *real* store.
 *
 * The component tests that existed before this rendered the presentation
 * components with hand-made props, which meant they never exercised the store
 * subscription — and the subscription is where the bug was. A selector that
 * derives a fresh array or object on every read gives `useSyncExternalStore` a
 * different snapshot each time it checks, and React aborts the render with
 * "The result of getSnapshot should be cached to avoid an infinite loop".
 *
 * These tests fail loudly if any container regresses to an unstable selector,
 * including the case that actually broke: zero agents, where the counts object
 * was still rebuilt on every read.
 */
function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

/** Fails the test if React logs the snapshot-caching error. */
let consoleError: ReturnType<typeof vi.spyOn>;
const logged: string[] = [];

beforeEach(() => {
  logged.length = 0;
  resetSequence();
  useAppStore.setState({ app: initialAppState });
  consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
    logged.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  consoleError.mockRestore();
});

function expectNoSnapshotWarning() {
  const offending = logged.filter(
    (line) => line.includes('getSnapshot') || line.includes('Maximum update depth')
  );
  expect(offending).toEqual([]);
}

function seed(...events: Parameters<typeof processEvents>[1]) {
  useAppStore.setState({ app: processEvents(initialAppState, events) });
}

describe('AgentActivity', () => {
  it('renders with no agents without looping', () => {
    // The original failure: with zero agents the counts selector still built a
    // new object each read, so the panel threw before any agent existed.
    const { container } = renderWithProviders(<AgentActivity />);
    expect(container).toBeEmptyDOMElement();
    expectNoSnapshotWarning();
  });

  it('renders agents from the store', () => {
    seed(
      makeEvent('planning.started', {
        planners: ['repository', 'architecture'],
        count: 2
      }),
      makeEvent(
        'planning.agent.started',
        { planner: 'repository', label: 'Repository', model: 'm' },
        { agentId: 'plan-repository' }
      )
    );

    renderWithProviders(<AgentActivity />);

    expect(screen.getByText('Repository')).toBeInTheDocument();
    expect(screen.getByText('Architecture')).toBeInTheDocument();
    expectNoSnapshotWarning();
  });

  it('survives a burst of events without aborting', () => {
    renderWithProviders(<AgentActivity />);

    for (let i = 0; i < 50; i++) {
      const next = processEvents(useAppStore.getState().app, [
        makeEvent(
          'tool.started',
          { name: 'read_file', args: `f${i}.ts` },
          { agentId: 'coder-1' }
        )
      ]);
      useAppStore.setState({ app: next });
    }

    expectNoSnapshotWarning();
  });
});

describe('ChangedFiles', () => {
  it('renders with no changes without looping', () => {
    const { container } = renderWithProviders(<ChangedFiles />);
    expect(container).toBeEmptyDOMElement();
    expectNoSnapshotWarning();
  });

  it('renders a proposed change from the store', () => {
    seed(
      makeEvent('file.edit.proposed', {
        id: 'e1',
        relPath: 'src/auth.ts',
        added: 12,
        removed: 3,
        isNewFile: false
      })
    );

    renderWithProviders(<ChangedFiles />);

    expect(screen.getByText('src/auth.ts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expectNoSnapshotWarning();
  });
});

describe('CommandList', () => {
  it('renders with no commands without looping', () => {
    const { container } = renderWithProviders(<CommandList />);
    expect(container).toBeEmptyDOMElement();
    expectNoSnapshotWarning();
  });

  it('renders a pending command from the store', () => {
    seed(
      makeEvent('command.proposed', {
        id: 'c1',
        command: 'npm test',
        cwd: '/repo',
        reason: 'runs the project checks',
        autoRun: false
      })
    );

    renderWithProviders(<CommandList />);

    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run/ })).toBeInTheDocument();
    expectNoSnapshotWarning();
  });
});
