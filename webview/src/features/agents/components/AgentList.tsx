import { memo } from 'react';
import { Panel, PanelHeading } from '../../../components/ui/Panel';
import type { AgentView } from '../../../types/view';
import { AgentCard } from './AgentCard';

/**
 * Every agent as a row, whatever its state.
 *
 * Showing waiting and finished agents alongside running ones is what makes a
 * parallel run look parallel — a list that only shows active work reads as one
 * agent doing things in sequence.
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

  return (
    <Panel label="Agent activity">
      <PanelHeading
        meta={`${running > 0 ? `${running} running · ` : ''}${done}/${agents.length} done`}
      >
        Agents
      </PanelHeading>
      <ul className="m-0 list-none p-0">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </ul>
    </Panel>
  );
});
