import { Bot } from 'lucide-react';
import { memo } from 'react';
import { Panel, PanelHeading, ProgressRail } from '../../../components/ui/Panel';
import type { AgentView } from '../../../types/view';
import { AgentCard } from './AgentCard';

/**
 * Every agent as a row, whatever its state.
 *
 * Showing queued and finished agents next to running ones is what makes a
 * parallel run legible — a list of only active work reads as one agent doing
 * things in sequence, which is precisely the impression to avoid.
 */
export const AgentList = memo(function AgentList({
  agents,
  running,
  done
}: {
  agents: readonly AgentView[];
  running: number;
  done: number;
}) {
  if (agents.length === 0) {
    return null;
  }

  const finished = done === agents.length;

  return (
    <Panel label="Agent activity" tone={running > 0 ? 'active' : 'neutral'}>
      <PanelHeading
        icon={<Bot size={13} aria-hidden />}
        tone={running > 0 ? 'active' : 'neutral'}
        meta={
          running > 0 ? (
            <span className="text-running">{running} running</span>
          ) : (
            `${done}/${agents.length}`
          )
        }
      >
        Agents
      </PanelHeading>

      <ProgressRail
        value={done}
        total={agents.length}
        tone={finished ? 'success' : 'active'}
      />

      <ul className="m-0 list-none p-0">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </ul>
    </Panel>
  );
});
