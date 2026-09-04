import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../app/App';
import { useAppStore } from '../store/appStore';
import { initialAppState, processEvents } from '../store/processEvent';
import { midRunEvents, verifiedEvents } from './fixtures';
import '../styles/globals.css';

/**
 * Development preview.
 *
 * Renders the real UI against seeded state so the design can be judged and
 * screenshotted without an Azure key or an Extension Development Host.
 * `preview.html` is not an input to the production build.
 */
const scenario = new URLSearchParams(location.search).get('scenario') ?? 'mid-run';
const events = scenario === 'verified' ? verifiedEvents() : midRunEvents();

/**
 * `?scenario=live` feeds events in one at a time, the way the host does during
 * a real run, so incremental rendering can be observed rather than assumed.
 */
if (scenario === 'live') {
  const all = verifiedEvents();
  let i = 0;
  const tick = () => {
    if (i >= all.length) {
      return;
    }
    useAppStore.getState().push(all[i]!);
    i += 1;
    window.setTimeout(tick, 90);
  };
  window.setTimeout(tick, 200);
}

useAppStore.setState({
  app:
    scenario === 'empty' || scenario === 'live'
      ? initialAppState
      : processEvents(initialAppState, events),
  status: {
    configured: true,
    endpoint: 'https://example.openai.azure.com',
    models: ['sol', 'luna', 'terra'],
    modes: [
      { mode: 'fast', label: 'Fast', description: 'Quick answers, read-only tools.' },
      {
        mode: 'thinking',
        label: 'Thinking',
        description: 'Inspects, plans, verifies.'
      },
      { mode: 'agent', label: 'Agent', description: 'Completes the task end to end.' }
    ],
    defaultMode: 'agent',
    defaultEffort: 'medium',
    orchestration: 'multi-agent',
    autoApprove: false
  },
  attachments:
    scenario === 'empty'
      ? []
      : [{ id: 'a1', name: 'auth-spec.md', kind: 'document', size: '12 kB' }]
});

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
