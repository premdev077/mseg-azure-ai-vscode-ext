import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../../store/appStore';
import {
  selectAgentCounts,
  selectOrderedAgents
} from '../../../store/selectors/agents';
import { AgentList } from './AgentList';

/**
 * Container: selects state, renders the presentation component.
 *
 * The split matters because `AgentList` and `AgentCard` take props only, which
 * makes them testable and reusable without a store.
 */
export function AgentActivity() {
  // useShallow: both selectors derive a fresh value each read, so identity
  // comparison would see a change on every store notification.
  const agents = useAppStore(useShallow((s) => selectOrderedAgents(s.app)));
  const counts = useAppStore(useShallow((s) => selectAgentCounts(s.app)));

  return <AgentList agents={agents} running={counts.running} done={counts.done} />;
}
