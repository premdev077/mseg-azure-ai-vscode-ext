import { useCallback, useEffect, useMemo } from 'react';
import { ErrorBoundary } from '../components/common/ErrorBoundary';
import {
  DisconnectedState,
  EmptyState,
  SuggestionButton
} from '../components/common/States';
import { Header } from '../components/layout/Header';
import { Button } from '../components/ui/Button';
import { TooltipProvider } from '../components/ui/Tooltip';
import { AgentActivity } from '../features/agents';
import { ChangedFiles } from '../features/changes';
import {
  ChatMessage,
  Composer,
  Notices,
  type MessageCallbacks
} from '../features/chat';
import { CommandList } from '../features/commands';
import { HistoryPanel } from '../features/history';
import { ToolActivity } from '../features/tools';
import { PlanPanel, VerificationPanel } from '../features/verification';
import { useStickyScroll } from '../hooks/useStickyScroll';
import { connectToHost, PREFILL_EVENT } from '../services/messageBridge';
import { host } from '../services/vscode';
import { useAppStore } from '../store/appStore';

const SUGGESTIONS = [
  'Where is authentication handled in this project?',
  'Run the type-check and fix whatever it reports.',
  'Add validation to the interview form, with tests.'
] as const;

/** Fills the composer without sending, so the wording can be adjusted first. */
function prefillComposer(text: string): void {
  window.dispatchEvent(
    new CustomEvent(PREFILL_EVENT, { detail: { text, autosend: false } })
  );
}

/**
 * The shell.
 *
 * Each region is wrapped in its own boundary so a render failure in the agent
 * panel cannot take the composer with it — the user must still be able to stop
 * the run and read what went wrong.
 */
function NotConfigured() {
  return (
    <div className="shrink-0 border-b border-line bg-surface p-2" role="alert">
      <p className="m-0 mb-2 text-xs">
        Not connected yet. Set your Azure OpenAI endpoint and deployment, then add your
        API key.
      </p>
      <div className="flex gap-1">
        <Button variant="primary" onClick={host.openSettings}>
          Open settings
        </Button>
        <Button variant="secondary" onClick={host.setApiKey}>
          Set API key
        </Button>
      </div>
    </div>
  );
}

function Transcript() {
  const messages = useAppStore((s) => s.app.chat.messages);
  const agents = useAppStore((s) => s.app.agents.ids.length);
  const plan = useAppStore((s) => s.app.verification.plan);
  const verification = useAppStore((s) => s.app.verification.verification);
  const contextLabels = useAppStore((s) => s.app.stream.contextLabels);
  const usageNote = useAppStore((s) => s.app.chat.usageNote);
  const connection = useAppStore((s) => s.app.stream.connection);

  // One cheap dependency that changes whenever anything appended, rather than
  // subscribing to every slice just to know when to scroll.
  const streamMarker = useAppStore(
    (s) =>
      s.app.chat.messages.length +
      s.app.stream.tools.length +
      s.app.changes.paths.length
  );
  const ref = useStickyScroll<HTMLDivElement>(streamMarker);

  const callbacks = useMemo<MessageCallbacks>(
    () => ({ onCopy: host.copy, onInsert: host.insertAtCursor }),
    []
  );

  const empty = messages.length === 0 && agents === 0;

  return (
    // The scroll container must not be a flex column: flex children shrink
    // by default, so the content compressed to fit instead of overflowing
    // and nothing ever scrolled. Block outside, flex inside.
    <div ref={ref} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <div className="flex flex-col gap-3 p-3">
        {empty && (
          <EmptyState
            title="AI Coding Assistant"
            description="Describe a change, ask about the code, or attach files to read."
          >
            <div className="flex w-full max-w-prose flex-col gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <SuggestionButton
                  key={suggestion}
                  onClick={() => prefillComposer(suggestion)}
                >
                  {suggestion}
                </SuggestionButton>
              ))}
            </div>
          </EmptyState>
        )}

        {connection === 'degraded' && (
          <DisconnectedState message="Some earlier activity is no longer held in memory, so this list may be incomplete. The work itself was not affected." />
        )}

        {contextLabels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {contextLabels.map((label) => (
              <span
                key={label}
                className="inline-flex items-center rounded-sm border border-line bg-surface px-1.5 py-px font-mono text-2xs text-muted"
              >
                @ {label}
              </span>
            ))}
          </div>
        )}

        {messages.map((message) => (
          <ChatMessage key={message.id} message={message} callbacks={callbacks} />
        ))}

        <ErrorBoundary region="plan panel">
          {plan && <PlanPanel plan={plan} />}
        </ErrorBoundary>
        <ErrorBoundary region="agent panel">
          <AgentActivity />
        </ErrorBoundary>
        <ErrorBoundary region="activity list">
          <ToolActivity />
        </ErrorBoundary>
        <ErrorBoundary region="command list">
          <CommandList />
        </ErrorBoundary>
        <ErrorBoundary region="changed files">
          <ChangedFiles />
        </ErrorBoundary>
        <ErrorBoundary region="verification panel">
          {verification && <VerificationPanel verification={verification} />}
        </ErrorBoundary>

        {usageNote !== undefined && (
          <p className="m-0 px-1 text-xs text-muted">{usageNote}</p>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const configured = useAppStore((s) => s.status?.configured);
  const phaseLabel = useAppStore((s) => s.app.stream.phaseLabel);
  const busy = useAppStore((s) => s.app.stream.busy);
  const connection = useAppStore((s) => s.app.stream.connection);
  const multiAgent = useAppStore((s) => s.status?.orchestration === 'multi-agent');
  const requestHistory = useAppStore((s) => s.requestHistory);

  const onHistory = useCallback(() => {
    requestHistory();
    host.openHistory();
  }, [requestHistory]);

  useEffect(() => connectToHost(), []);

  return (
    <TooltipProvider>
      <div className="flex h-full min-w-0 flex-col">
        <Header
          phaseLabel={phaseLabel}
          busy={busy}
          connection={connection}
          multiAgent={multiAgent}
          onNewChat={host.newChat}
          onHistory={onHistory}
          onSettings={host.openSettings}
        />
        {configured === false && <NotConfigured />}
        <Notices />
        <ErrorBoundary region="history panel">
          <HistoryPanel />
        </ErrorBoundary>
        <ErrorBoundary region="transcript">
          <Transcript />
        </ErrorBoundary>
        <ErrorBoundary region="composer">
          <Composer />
        </ErrorBoundary>
      </div>
    </TooltipProvider>
  );
}
