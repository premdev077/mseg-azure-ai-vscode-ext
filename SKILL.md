---
name: react-vite-webview
description: Engineering standards for the React + TypeScript + Vite multi-agent Webview app running inside a VS Code extension. Use for any code change in the webview — new features, refactors, bug fixes, reviews — covering architecture, event/streaming design, Zustand state, the extension↔webview message bridge, Tailwind + VS Code theming, Radix accessibility, performance, testing, CI and security.
---

# React + TypeScript + Vite Webview — Engineering Standards

Production-grade React app running inside a **VS Code Webview**, driving a **multi-agent streaming workflow**.

Optimise in this order: **Correctness → Clarity → Reuse → Maintainability → Testability → Performance**.
Do *not* optimise for fewest lines written.

The final test for every change:

> Can another senior developer understand, test, extend and safely change this in six months without reading the whole codebase?

---

## 0. Non-negotiables

Violating any of these fails review, regardless of how well the feature works.

| # | Rule |
|---|------|
| 1 | No `any` without an inline `// why:` justification. |
| 2 | No component subscribes to the backend event stream directly. Events flow through one store. |
| 3 | No `acquireVsCodeApi()`, `postMessage`, `fetch`, `WebSocket` or `EventSource` inside a component. |
| 4 | Every message crossing extension↔webview is **validated** before it touches state. |
| 5 | No hard-coded colours where a VS Code theme variable exists. |
| 6 | No `<div onClick>` for anything interactive. |
| 7 | No empty `catch {}`. Every async path has a defined failure behaviour. |
| 8 | No new dependency without checking `package.json` and existing shared code first. |
| 9 | Event handling must be idempotent — duplicates and replays are expected, not exceptional. |
| 10 | Every data-driven view handles loading / empty / error / disconnected. |
| 11 | Business logic lives outside presentation components. |
| 12 | Typecheck + lint + tests + production build pass before the change is "done". |

---

## 1. Stack and dependency policy

Fixed stack: **React, TypeScript, Vite, Tailwind CSS, Radix UI, Lucide React, Zustand** (shared state only), VS Code CSS theme variables, and the existing streaming/event architecture.

Do not introduce a second UI framework, a second icon set, a second state library, a second styling system, or a competing event system. Familiarity is not an architectural reason.

**Before adding any dependency**, in order:

1. Read `package.json` — is it already there (possibly transitively, deliberately)?
2. Does an installed library already do this? (Radix, Zustand middleware, native `Intl`, `AbortController`, `structuredClone`.)
3. Does a shared component / hook / util / service already do this?
4. Can 30 lines in `utils/` replace it?
5. Only then: evaluate size, maintenance, tree-shakeability, licence, transitive weight.

Webview bundles ship inside an editor. **Bundle size is a user-facing feature.** A 90 kB dependency for one formatting call is a rejection.

---

## 2. Recon protocol — before writing code

Never start with a blank file. Every task begins by reading:

```
package.json          → what exists, what scripts run
tsconfig.json         → strictness, path aliases
vite.config.*         → build, chunking, aliases
tailwind.config.*     → tokens, theme extension
src/types/            → the domain vocabulary
src/store/            → who owns what state
src/services/         → how we talk to the outside
src/components/ui/    → primitives that already exist
src/components/common/→ app-wide patterns that already exist
the nearest existing feature that does something similar
```

Then answer explicitly, before implementing:

- Which existing components / hooks / stores / services / types / utils can I reuse?
- Where does this state live — local, feature store, or shared store?
- What is the event flow? Which events create, mutate and terminate this state?
- What are the component boundaries?
- What is the test strategy?
- What is the failure behaviour?

**Golden question:** *Does this already exist somewhere in the application?*
Yes → reuse. Almost → generalise carefully. Genuinely new → build it at the correct layer.

---

## 3. Project structure

Feature-oriented. Shared code moves *up*; feature code stays *down*.

```
src/
├── app/                 App.tsx, AppProviders.tsx, routes.ts, ErrorBoundary wiring
│
├── components/
│   ├── ui/              Primitives: Button, Input, Badge, Dialog, DropdownMenu,
│   │                    Tooltip, Tabs, ScrollArea, Separator, Spinner, Progress
│   ├── layout/          AppLayout, Sidebar, MainContent, Panel, SplitPane
│   └── common/          EmptyState, LoadingState, ErrorState, DisconnectedState,
│                        StatusBadge, ConfirmDialog, VirtualList, RelativeTime
│
├── features/
│   ├── chat/            components/ hooks/ services/ store/ types/ utils/
│   ├── agents/          components/ hooks/ services/ store/ types/ utils/
│   ├── streaming/       components/ hooks/ services/ store/ types/
│   ├── tasks/           components/ hooks/ services/ store/ types/
│   ├── files/
│   ├── verification/
│   └── settings/
│
├── hooks/               useDebounce, useKeyboardShortcut, useVSCodeMessage,
│                        useStableCallback, useIntersection, usePrevious
│
├── services/            vscode.ts, eventStream.ts, logger.ts, telemetry.ts, persistence.ts
├── store/               appStore.ts, selectors/
├── types/               events.ts, common.ts, vscode.ts, result.ts
├── utils/               cn.ts, date.ts, formatting.ts, validation.ts, invariant.ts
├── constants/           events.ts, limits.ts, ui.ts, shortcuts.ts
├── config/              featureFlags.ts, env.ts
├── i18n/                messages.ts
└── styles/              globals.css, vscode-theme.css
```

**Placement rules**

- Used by one feature → keep inside that feature.
- Used by two features → move to the shared layer (`components/common`, `hooks/`, `utils/`, `services/`).
- Never import feature A from feature B. If they need the same thing, promote it.
- `components/ui/` knows nothing about agents, tasks, or the event stream. It is domain-free.

**Promotion trigger:** the *second* time you need it, promote it. Not the first (premature), not the third (duplication has already drifted).

---

## 4. Layering and dependency direction

```
UI primitives  ←  Presentation  ←  Feature components  ←  Containers
                                          ↓
                                  Hooks / Selectors
                                          ↓
                          ┌───────────────┴───────────────┐
                     Zustand stores                   Services
                          └───────────────┬───────────────┘
                                          ↓
                            Event / VS Code integration layer
                                          ↓
                                   Extension host
```

Dependencies point **downward only**.

- UI never knows how the extension host is reached.
- Stores never import components.
- Services never import stores (services emit; stores subscribe or are called by an orchestrator).
- Utils import nothing but other utils and types.

Enforce with `eslint-plugin-import` boundaries or `dependency-cruiser` (§26). A circular import is a design error, not a bundler warning.

---

## 5. Component architecture

```
AgentWorkspace   (container: wiring, state selection)
   ↓
AgentList        (feature: domain layout)
   ↓
AgentCard        (presentation: renders props)
   ↓
StatusBadge      (common)
   ↓
Badge            (ui primitive)
```

**Composition over duplication.** Where structure is shared and only detail differs:

```tsx
// Not this
<PlanningAgentCard /> <CodingAgentCard /> <TestingAgentCard />

// This
<AgentCard agent={agent} variant="planning" />
<AgentCard agent={agent} variant="coding" />
```

Create a specialised component only when *behaviour* genuinely differs, not when a label or icon differs.

**Size:** no arbitrary line limit — but split when a component holds unrelated responsibilities. Warning signs: several unrelated `useEffect`s, event parsing, async calls, business rules, repeated JSX blocks, deep conditional trees.

```tsx
function AgentWorkspace() {
  const agents = useAgents();
  return (
    <WorkspaceLayout>
      <AgentToolbar />
      <AgentList agents={agents} />
      <AgentDetails />
    </WorkspaceLayout>
  );
}
```

**Props:** intentional and minimal. Pass what the component renders, not the world.

```ts
// No
interface Props { data: any; config: any; options: any }

// Yes
interface AgentCardProps {
  agent: Agent;
  selected?: boolean;
  onSelect?: (agentId: string) => void;
}
```

Prefer required props over optional ones with silent defaults. Prefer a discriminated union of prop shapes over a bag of optional booleans that can contradict each other.

---

## 6. TypeScript

Strict mode on. Target these compiler options:

```jsonc
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "verbatimModuleSyntax": true,
  "isolatedModules": true
}
```

Rules:

- `any` is banned without a `// why:` comment. Use `unknown` at boundaries and narrow.
- No `as` casts across unrelated types. Narrow with a type guard or a parser instead.
- No non-null `!` on data that crossed a boundary.
- Model domain concepts explicitly; do not pass raw strings where a union exists.

```ts
export type AgentStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Agent {
  id: AgentId;
  name: string;
  role: AgentRole;
  status: AgentStatus;
}
```

**Branded IDs** stop the classic `taskId`/`agentId` swap:

```ts
type Brand<T, B extends string> = T & { readonly __brand: B };
export type AgentId = Brand<string, 'AgentId'>;
export type TaskId  = Brand<string, 'TaskId'>;
export type RunId   = Brand<string, 'RunId'>;
```

**Discriminated unions** for anything with variants — events, results, view models:

```ts
type AgentEvent =
  | AgentStartedEvent
  | AgentProgressEvent
  | AgentCompletedEvent
  | AgentFailedEvent;
```

**Exhaustiveness** on every switch over a union:

```ts
export function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}
```

Adding a new event type must then break the build everywhere it is handled — that is the point.

**Result type** for expected failures (keep exceptions for bugs):

```ts
export type Result<T, E = AppError> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

Prefer `type` for unions and object shapes; `interface` for extensible public contracts. Prefer `readonly` on arrays and props you do not mutate.

---

## 7. Multi-agent event architecture

The event stream is the backbone. It is the **single source of truth** for real-time state. Do not build a second one.

### Flow

```
Backend → Event stream → Extension host → Message bridge → Event store → Selectors → Components
```

Components **consume derived state**. They never subscribe upstream.

```
// Wrong                        // Right
AgentCard   → stream            Stream → eventStore
AgentList   → stream                       ↓
TaskPanel   → stream                   selectors
VerifyPanel → stream                       ↓
                                       components
```

Multiple subscriptions mean duplicated work, divergent state, and bugs that only reproduce on reconnect.

### Envelope

Every event carries the same envelope. Version it from day one.

```ts
interface EventEnvelope<T extends AgentEventType = AgentEventType> {
  eventId: string;          // unique — dedupe key
  eventVersion: string;     // schema version of `data`
  runId: RunId;
  taskId: TaskId;
  agentId?: AgentId;
  parentEventId?: string;   // causal tree
  sequence: number;         // monotonic per run
  timestamp: string;        // ISO 8601, backend clock
  type: T;
  data: EventDataMap[T];    // typed per event type, never `any`
}
```

### Processing contract

All events go through one reducer:

```ts
eventStore.process(event);
```

That reducer must guarantee:

| Concern | Required behaviour |
|---|---|
| **Validation** | Parse/validate before touching state. Invalid → log, drop, count. Never crash the UI. |
| **Idempotency** | `eventId` already seen → ignore. Reconnects replay. |
| **Ordering** | Apply by `sequence`. Out-of-order arrivals buffer briefly, then flush. |
| **Gaps** | Missing sequence beyond a threshold → mark stream degraded, request resync, surface it. |
| **Unknown types** | Forward-compatible: ignore unknown `type`, log once, keep processing. |
| **Version skew** | Unknown `eventVersion` → apply known fields, ignore the rest, log once. |
| **Terminal states** | Terminal events are final. Late non-terminal events for a finished agent are dropped. |
| **Backpressure** | Batch high-frequency events into an animation-frame or interval flush. Do not `setState` per token. |

```ts
// Ignore duplicate events because reconnects replay the tail of the stream.
if (seen.has(event.eventId)) return;
```

### Retention

Raw events are kept only for debugging, audit, replay and diagnostics — bounded by count and age (`constants/limits.ts`). Normalised entity state is what the UI reads.

```
Raw events (ring buffer, capped)
      ↓
Normalised entities (Record<Id, Entity>)
      ↓
Derived view models (selectors, memoised)
      ↓
Virtualised timeline
```

### Streaming UI

Render progress as it arrives; never wait for completion.

```
Task started → Planning → Plans complete → Coding → Files changing → Tests → Verification → Done
```

The UI must stay interactive while events arrive. Cancellation must be reflected immediately and optimistically, then confirmed.

---

## 8. State and Zustand

**Local first.** `useState` for anything one subtree owns:

```ts
const [isOpen, setIsOpen] = useState(false);
```

Promote to Zustand only when unrelated components need it: current task, agent states, streaming connection state, event history, selection, changed files, verification state, preferences.

**Domain stores, not one god store:**

```
store/
├── agentStore.ts
├── taskStore.ts
├── streamingStore.ts
└── verificationStore.ts
```

**Normalise.** `Record<Id, Entity>` plus ordered `Id[]`, never nested arrays you rewrite wholesale.

```ts
interface AgentStore {
  byId: Record<AgentId, Agent>;
  idsByTask: Record<TaskId, AgentId[]>;
  updateAgent: (agent: Agent) => void;
  removeAgent: (id: AgentId) => void;
}
```

**Expose actions, never raw setters.** Components describe intent; the store owns the transition.

**Select narrowly.** A component subscribing to the whole store re-renders on every event.

```ts
// Re-renders on any store change
const agents = useAgentStore(s => s.getAgentsForTask(taskId));           // ✗ new array each call

// Stable
const agentIds = useAgentStore(useShallow(s => s.idsByTask[taskId] ?? EMPTY));
const agent    = useAgentStore(s => s.byId[agentId]);
```

Keep selectors in `store/selectors/`, unit-tested as pure functions. Export module-level `EMPTY_ARRAY` constants so empty results are referentially stable.

Devtools middleware in development only. Persist middleware only for genuine preferences, through the VS Code state API (§11), never `localStorage`.

**One source of truth.** If a value can be derived, derive it. Duplicated state is how two panels disagree.

---

## 9. Hooks

A hook encapsulates *reusable React behaviour* — subscription, lifecycle, derived state.

Good: `useAgent`, `useAgentEvents`, `useTask`, `useEventStream`, `useKeyboardShortcut`, `useVSCodeMessage`, `useDebounce`.

Rules:

- One responsibility. A hook that fetches, transforms, caches and renders is a service in disguise.
- Return a stable, documented shape. Prefer an object with named fields over positional tuples beyond two.
- Every effect that subscribes must clean up. Every async effect must handle unmount (`AbortController` or a cancelled flag).
- No `useEffect` for state that can be derived during render.
- Effects have a single reason to run. Two unrelated concerns → two effects.
- Custom hooks are unit-testable; test them directly rather than through a component where practical.

```ts
useEffect(() => {
  const controller = new AbortController();
  void load(controller.signal);
  return () => controller.abort();
}, [load]);
```

---

## 10. Services

Services own external communication and infrastructure. They are plain modules — testable without React.

```
services/
├── vscode.ts        message bridge
├── eventStream.ts   subscription, reconnect, backoff
├── logger.ts
├── telemetry.ts
└── persistence.ts   VS Code webview state
```

Components call `agentService.startAgent(...)` or `vscodeService.send(...)` — never a transport API directly.

Services return `Result` or throw typed errors; they never render, never touch a store directly (an orchestrator or store subscribes to them), and never swallow failures silently.

**Reconnect belongs here**, not in a component: exponential backoff with jitter, capped attempts, a `lastSequence` cursor for resume, and an observable connection state (`connecting | open | degraded | closed`) that the UI renders.

---

## 11. VS Code integration and the message bridge

`acquireVsCodeApi()` is called **exactly once**, in `services/vscode.ts`. Nowhere else.

```ts
const vscode = getVSCodeApi();
vscode.postMessage(msg);
```

Centralise: outbound messages, inbound dispatch, command handling, and persisted webview state (`getState`/`setState` — not `localStorage`, which does not survive webview reloads reliably).

### The bridge is a contract

Treat extension↔webview as a network boundary with an untrusted peer on both sides.

```ts
type WebviewToHost =
  | { type: 'agent/start'; payload: { taskId: TaskId } }
  | { type: 'task/cancel'; payload: { taskId: TaskId } };

type HostToWebview =
  | { type: 'event'; payload: EventEnvelope }
  | { type: 'state/sync'; payload: SyncSnapshot }
  | { type: 'error'; payload: { code: string; message: string } };
```

Requirements:

- **Validate every inbound message** with a runtime schema (Zod or hand-written guards) before it reaches state. A malformed message logs and drops; it never throws into React.
- **Version the protocol.** Include a protocol version in the handshake; degrade explicitly on mismatch rather than failing mysteriously.
- **Correlate requests.** Include a `requestId` on request/response pairs, with a timeout and a defined timeout behaviour.
- **Handshake on mount.** The webview announces readiness; the host replies with a snapshot. Never assume the host is listening before that.
- **Survive reload.** VS Code disposes and recreates webviews. Persist minimal state (`setState`) and rehydrate from a host snapshot, not from memory.
- **Never trust the peer.** Do not `eval`, do not render unsanitised HTML, do not build DOM from message content.

Keep this layer thin and behind an interface so tests can supply a fake bridge.

---

## 12. Tailwind CSS

Utility classes for layout and spacing:

```tsx
<div className="flex items-center gap-2 px-3 py-2">
```

- Don't write custom CSS for what Tailwind already does.
- Repeated class strings → extract a component, not a `@apply` blob.
- Use `cn()` for conditional classes; use `tailwind-merge` inside `cn()` so overrides via `className` props actually win.
- Avoid arbitrary values (`w-[437px]`) unless genuinely necessary — add a token instead.
- Order matters for overrides: base classes first, variant classes second, incoming `className` last.

```ts
cn('rounded-md border border-[var(--app-border)]', isActive && 'border-[var(--vscode-focusBorder)]', className)
```

For components with several variants, use `class-variance-authority` (or an equivalent variant map) rather than nested ternaries.

---

## 13. VS Code theme integration

The UI must be correct in **dark, light and high-contrast** themes. Never hard-code an application colour where a theme variable exists.

Define semantic tokens once, map to VS Code variables, then use tokens everywhere:

```css
:root {
  --app-background:        var(--vscode-editor-background);
  --app-foreground:        var(--vscode-editor-foreground);
  --app-muted:             var(--vscode-descriptionForeground);
  --app-border:            var(--vscode-panel-border);
  --app-focus:             var(--vscode-focusBorder);
  --app-accent:            var(--vscode-button-background);
  --app-accent-foreground: var(--vscode-button-foreground);
  --app-input-bg:          var(--vscode-input-background);
  --app-error:             var(--vscode-errorForeground);
  --app-warning:           var(--vscode-editorWarning-foreground);
  --app-success:           var(--vscode-testing-iconPassed);
}
```

Expose them to Tailwind through `theme.extend.colors` so utilities stay idiomatic.

Rules:

- Never assume a background is dark. Never assume text is light.
- High contrast: rely on borders and focus outlines, not subtle background shifts. Test with `.vscode-high-contrast` on the body.
- Status must never be communicated by colour alone (§14).
- Respect `prefers-reduced-motion`.
- Use the editor font variables (`--vscode-editor-font-family`, `--vscode-font-size`) for code and body text rather than fixed stacks.

---

## 14. Radix UI, Lucide, and the internal design system

Use **Radix** for dialogs, dropdowns, menus, tooltips, tabs, popovers, context menus, selects, scroll areas. Do not hand-roll accessible primitives.

Wrap Radix in `components/ui/` so the app has one consistent, themed interface and swapping the implementation is a single-file change.

Use **Lucide React** for icons — one icon library only:

```tsx
import { Check, X, LoaderCircle } from 'lucide-react';
```

Icons need consistent sizing, theme-aware colour, and an accessible name when meaningful (`aria-hidden` when decorative).

**The design system:**

```
Button, IconButton, Input, Textarea, Select, Checkbox, Badge, StatusBadge,
Card, Panel, Dialog, DropdownMenu, Tooltip, Tabs, Separator,
Spinner, Progress, EmptyState, ErrorState, LoadingState, DisconnectedState
```

Never create `AgentButton`, `TaskButton`, `ChatButton`. Differences that can be props must be props:

```tsx
<Button variant="primary" size="sm" loading={isSubmitting}>Run</Button>
```

`Button` owns its disabled + loading semantics (`aria-busy`, `aria-disabled`, pointer-events) so no caller reimplements them.

---

## 15. Accessibility

Non-optional. Every interactive element must be keyboard-operable and screen-reader-legible.

- Use semantic elements: `<button>`, `<a>`, `<nav>`, `<ul>`, `<label>`. Never `<div onClick>`.
- Visible focus that survives theming — never `outline: none` without a replacement.
- Manage focus on dialog open/close and on route/panel changes; return focus to the trigger.
- Label everything: `aria-label`, `aria-labelledby`, `<label htmlFor>`.
- Streaming regions: `aria-live="polite"` for progress, `role="alert"` for failures. Do not announce every token — announce state transitions.
- Status uses icon + text + colour, never colour alone.
- Loading and disabled states expose `aria-busy` / `aria-disabled`.
- Virtualised lists need correct `role`, `aria-setsize`, `aria-posinset`.
- Respect `prefers-reduced-motion` for spinners, transitions and auto-scroll.
- Keyboard shortcuts must not shadow VS Code's own bindings; register them in `constants/shortcuts.ts` and make them discoverable.

Check: navigate the whole feature with the keyboard only, then with a screen reader, before calling it done.

---

## 16. Error handling

Every async operation has a defined error path: network errors, stream disconnects, invalid events, timeouts, cancellation, tool failures, agent failures, bridge failures.

```ts
// No
try { await operation(); } catch {}

// Yes
try {
  await operation();
} catch (error) {
  logger.error('Failed to start agent', { taskId, error });
  throw new AppError('AGENT_START_FAILED', { cause: error });
}
```

Rules:

- Distinguish **expected failures** (`Result`, rendered as UI) from **bugs** (thrown, caught by a boundary).
- Typed errors with a stable `code` — the UI branches on codes, not on message strings.
- User-facing messages are actionable: what failed, why, what to do next, and a retry affordance.
- Never surface raw stack traces to users; log them with correlation IDs (`runId`, `taskId`, `eventId`).
- Cancellation is not an error. Treat `AbortError` as a normal outcome.

**Error boundaries** at three levels: app root (fatal fallback + reload), each major panel (isolate a crash to one panel), and around any risky renderer (markdown, diff, third-party). Boundaries report to `logger` and offer a reset.

**Suspense** only where a real async boundary exists, always with a matching skeleton fallback and an error boundary above it. Do not wrap streaming state in Suspense — streaming has its own incremental states.

---

## 17. Loading, empty, error and disconnected states

Every data-driven feature explicitly handles:

```
Loading · Loaded · Empty · Error · Refreshing · Disconnected · Degraded · Cancelled
```

Use shared components — `<LoadingState />`, `<EmptyState />`, `<ErrorState />`, `<DisconnectedState />` — so behaviour and tone are consistent.

- No blank screens, ever.
- Prefer skeletons matching the final layout over spinners; avoids layout shift.
- Empty states say what will appear here and offer the action that fills it.
- Distinguish "no data yet" from "no results for this filter" from "failed to load".
- Show a stream-degraded banner when sequences are gapped, with a resync action.

---

## 18. Performance

Measure before optimising. Then optimise the real cause.

- `useMemo` / `useCallback` / `React.memo` solve identified problems; blanket memoisation adds cost and noise.
- Normalise state and update only the affected entity — never replace whole collections on every event.
- Narrow Zustand selectors with `useShallow`; keep referential stability for arrays and objects.
- Batch high-frequency stream updates (rAF or a short interval) rather than per-event `setState`.
- Split components so a hot streaming region doesn't re-render a static shell.
- Keep expensive derivations in memoised selectors, not in render.
- Virtualise any list that can exceed a few hundred rows — event timelines above all.
- Avoid long synchronous work on the main thread; chunk it or move it to the extension host.
- Lazy-load heavy, rarely-opened panels with `React.lazy` + Suspense.

**Budgets** (adjust to your baseline, then enforce in CI):

| Metric | Budget |
|---|---|
| Initial JS (gzipped) | ≤ 250 kB |
| Any single lazy chunk | ≤ 150 kB |
| Time to interactive shell | ≤ 500 ms |
| Frame budget under stream load | ≥ 50 fps |
| Event → paint latency | ≤ 100 ms |

Profile with the React Profiler and `why-did-you-render` in development. Add a synthetic stress test (10 000 events) to catch regressions.

---

## 19. Vite and bundling

- Path aliases in `tsconfig.json` and `vite.config.ts` must match exactly.
- Manual chunks for large vendor groups; verify with `rollup-plugin-visualizer` when size moves.
- Ban Node built-ins and polyfills — this is a webview.
- Prefer per-icon imports (Lucide is tree-shakeable) over namespace imports.
- Only `import.meta.env.VITE_*` values reach the bundle, and none of them are secrets (§23).
- Enable sourcemaps for the extension's diagnostics build; keep them out of the shipped default.
- Track bundle size in CI and fail on a regression above the budget (`size-limit` or a visualizer diff).

---

## 20. Logging, telemetry and diagnostics

Never scatter `console.log`. Use one logger:

```ts
logger.debug(...) logger.info(...) logger.warn(...) logger.error(...)
```

- Level-controlled; `debug` off by default in production builds.
- Structured context objects, not string concatenation.
- Forward to the extension's output channel so users can attach logs to a bug report.
- **Never log** tokens, secrets, credentials, prompts containing customer content, file contents, or repository data.

**Telemetry** (if present): behind `services/telemetry.ts`, respects VS Code's `telemetry.telemetryLevel`, event names and shapes typed and centralised, no free-text user content, no PII, and opt-out honoured. Measure event throughput, reconnect counts, dropped/duplicate events, error codes and render timings — not user content.

**Diagnostics panel** worth building once: connection state, last sequence, dropped/duplicate counters, buffered event count, store sizes, and an export-events action. It pays for itself the first time a stream bug appears in the field.

---

## 21. Feature flags and configuration

Keep flags in `config/featureFlags.ts` with typed keys, defaults, and a single read path:

```ts
export const flags = { agentTimeline: true, verificationRepair: false } as const;
export type FeatureFlag = keyof typeof flags;
```

- Flags are read through one hook (`useFeatureFlag`) so they can later come from settings or the host without touching call sites.
- Flags gate at the highest sensible boundary — one branch, not twelve scattered conditionals.
- Every flag has an owner and a removal plan. Delete flags once the feature ships; stale flags are dead branches that rot.
- Configuration that users control belongs in VS Code settings (`contributes.configuration`), delivered to the webview through the bridge — not duplicated in webview-only storage.

---

## 22. Internationalisation and content

Even if the app ships English-only today, avoid the choices that make i18n a rewrite:

- No concatenated sentences from fragments. One message = one key with parameters.
- Centralise user-facing strings in `i18n/messages.ts` (or a feature-local `messages.ts`), never inline in deep JSX.
- Format dates, numbers, relative times, plurals and lists with `Intl`, using the VS Code display language — never hand-rolled `"1 items"`.
- No layout that breaks when a string is 40 % longer.
- Keep tone consistent: sentence case, no exclamation marks in errors, plain language, no blame.

---

## 23. Security

The webview runs untrusted-adjacent content inside the user's editor. Treat it accordingly.

- **No secrets in the webview.** No API keys, tokens, or credentials in bundles, `import.meta.env`, state, or logs. The extension host holds them and makes privileged calls.
- **Validate every inbound message** (§11). The host must equally validate every webview message — a compromised webview must not be able to drive arbitrary host actions.
- **Least data.** Send the webview only what it renders. Never stream whole repositories or file contents "just in case".
- **Strict CSP** in the webview HTML: nonce-based scripts, no `unsafe-inline`, no `unsafe-eval`, restricted `img-src`/`font-src`, and `default-src 'none'`.
- **Use `asWebviewUri`** for all local resources; set `localResourceRoots` narrowly.
- **No `dangerouslySetInnerHTML`** without sanitising through a vetted sanitiser, and only for content you must render as markup.
- **No direct network calls from the webview.** Route through the host, where policy, proxying and auth live.
- **Sanitise anything rendered from model or tool output** — links, images, HTML in markdown. Open external links via the host, not `window.open`.
- **Path handling:** never construct or trust file paths from webview input without host-side validation against the workspace root.

**Threat model, briefly:** the realistic attackers are malicious repository content and malicious model/tool output rendered in the webview. Both reach the UI as data. Both are handled by validation at the bridge, sanitisation at render, and no privileged capability in the webview itself.

---

## 24. Testing

Test business logic away from the DOM; test UI at the behaviour level.

| Layer | What to test | Tooling |
|---|---|---|
| Utils | Pure functions, formatting, guards | Vitest |
| Event reducer | Ordering, dedupe, gaps, terminal states, version skew | Vitest |
| Stores/selectors | Transitions, derived shapes, referential stability | Vitest |
| Services | Reconnect/backoff, protocol, timeouts | Vitest + fake bridge/timers |
| Hooks | Subscription, cleanup, cancellation | Testing Library `renderHook` |
| Components | Rendered behaviour, a11y roles, keyboard | Testing Library |
| Features | Event → UI integration with a fake bridge | Testing Library |

**Highest-value tests in this app:**

- Event processing: ordering, duplicates, gaps, unknown types, version skew.
- Agent and task state transitions, including illegal transitions.
- Stream reconnect and replay-from-sequence.
- Cancellation mid-stream.
- Verification failure and repair flow.
- File change handling.
- Every error state renders something actionable.

**Practices:**

- Query by role and accessible name, not by `data-testid` or class. Tests that read like a user are tests that catch real breakage.
- Build test factories (`makeAgent`, `makeEvent`) rather than repeating fixtures.
- No snapshot tests of large trees; they assert nothing and block refactors. Small, targeted snapshots only.
- Fake timers for backoff and batching; deterministic clocks for anything timestamped.
- Add `axe` assertions on key views.
- Every bug fix ships with the test that would have caught it.

Coverage is a signal, not a target. Prioritise the event pipeline and state machines.

---

## 25. Component workbench and visual regression

Where a Storybook (or equivalent) exists, or when you introduce one:

- Every `components/ui/` primitive has stories covering each variant, size, and state (default, hover, focus, disabled, loading, error).
- Stories render under dark, light and high-contrast VS Code themes via a decorator supplying the theme variables.
- Stories are the a11y and visual-regression surface: run `axe` per story; snapshot images per theme.
- Stories double as documentation — a new developer should find the button variants without reading the source.

---

## 26. Tooling enforcement

Standards that aren't enforced decay. Make the tooling say no.

- **ESLint:** `@typescript-eslint` (type-aware), `react-hooks` (`exhaustive-deps` as error), `jsx-a11y`, `import` with boundary rules.
- **Boundary rules:** `no-restricted-imports` to block cross-feature imports and to block `acquireVsCodeApi` outside `services/vscode.ts`.
- **`dependency-cruiser`:** forbid circular dependencies and upward imports (services → stores → components).
- **Prettier:** formatting is not a review topic. Run on commit.
- **`knip` / `ts-prune`:** find dead exports and unused dependencies.
- **`size-limit`:** bundle budgets as a failing check.
- **Husky + lint-staged:** typecheck-adjacent lint and format on commit; full gate in CI.

Useful `no-restricted-imports` shape:

```jsonc
{ "patterns": [
  { "group": ["@/features/*/!(index)"], "message": "Import features through their public index." },
  { "group": ["**/services/vscode"], "message": "Use the injected bridge; only services may import this." }
]}
```

---

## 27. CI pipeline

Every PR runs, in order, failing fast:

```
1. install (frozen lockfile)
2. typecheck        tsc --noEmit
3. lint             eslint --max-warnings=0
4. format check     prettier --check
5. depcruise        no cycles, no boundary violations
6. unit + component tests, with coverage on changed files
7. production build vite build
8. bundle budget    size-limit
9. a11y checks      axe on key views / stories
10. (nightly) visual regression across dark/light/high-contrast
```

Rules: no green-by-skipping. Flaky tests get fixed or deleted the same week, never `.skip`ped indefinitely. The build must be reproducible from a clean checkout.

---

## 28. Decisions and migrations

**ADRs.** Any decision that is expensive to reverse — state library, event envelope shape, protocol version, bundling strategy, virtualisation approach — gets a short `docs/adr/NNNN-title.md`: context, decision, alternatives considered, consequences. Half a page. Written when the decision is made, not afterwards.

**Migrations.** When changing a shared contract (event envelope, store shape, message protocol, a widely used component API):

1. Add the new shape alongside the old.
2. Adapt at the boundary so both work.
3. Migrate call sites incrementally, in reviewable batches.
4. Mark the old shape `@deprecated` with the replacement named.
5. Remove the old shape once nothing references it — same milestone, not "later".

Never a big-bang rewrite of a working feature. Never leave step 5 undone; two half-migrated shapes are worse than either one.

---

## 29. Refactoring existing code

1. Understand the current implementation and *why* it is that way.
2. Identify the existing patterns and follow them.
3. Reuse what exists.
4. Preserve behaviour — characterise it with tests first if it isn't covered.
5. Make the smallest safe architectural improvement.
6. Separate refactor commits from behaviour-change commits.
7. Refactor where it improves maintainability, not where it satisfies taste.

Do not rewrite a feature because the current implementation is imperfect. Do improve the part you are touching (leave it better than you found it), then stop.

---

## 30. Naming and comments

**Naming** — say what it is:

```
Components   AgentCard.tsx, VerificationPanel.tsx, TaskTimeline.tsx, ChangedFilesList.tsx
Hooks        useAgent.ts, useTaskEvents.ts, useEventStream.ts
Services     agentService.ts, eventStreamService.ts, vscodeService.ts
Types        agent.ts, task.ts, events.ts, verification.ts
```

Banned: `stuff.ts`, `helpers.ts`, `common.ts`, `manager.ts`, `misc.ts`, `utils2.ts`, `data`, `handleClick2`, `temp`.

Booleans read as assertions (`isRunning`, `hasChanges`, `canCancel`). Handlers are `onX` (prop) / `handleX` (implementation). Async functions say what they return, not that they are async.

**Comments** explain *why*, never *what*:

```ts
// Bad
counter++; // increment counter

// Good
// Ignore duplicate events: reconnects replay the last sequence window.
if (event.sequence <= lastSequence) return;
```

Comment non-obvious constraints, protocol quirks, deliberate deviations, and anything a future reader would "clean up" and break. Delete commented-out code — git remembers.

---

## 31. Anti-patterns

| Anti-pattern | Why it hurts | Do instead |
|---|---|---|
| Component subscribes to the stream | Duplicate subscriptions, divergent state | One store, selectors |
| One 800-line workspace component | Untestable, unreviewable | Container + feature + presentation |
| `data: any` on events | Runtime crashes, no refactor safety | Discriminated union + `EventDataMap` |
| `useEffect` syncing derived state | Extra renders, stale values, loops | Derive during render or in a selector |
| Whole-store subscription | Re-renders on every event | Narrow selector + `useShallow` |
| Magic event strings | Silent typos, no find-all-references | Typed constants / union |
| `AgentButton`, `TaskButton`, … | Combinatorial component sprawl | `<Button variant=…>` |
| Empty `catch {}` | Invisible failures, unreproducible bugs | Log + typed error + UI state |
| Hard-coded `#1e1e1e` | Breaks in light and high-contrast | Theme variable / semantic token |
| `<div onClick>` | Keyboard and screen readers excluded | `<button>` or Radix |
| Rendering full event history | DOM blowup, dropped frames | Normalise + virtualise |
| `localStorage` in the webview | Lost on reload, CSP surprises | `vscode.setState` via `persistence.ts` |
| Secrets in `import.meta.env` | Shipped in the bundle | Keep in the extension host |
| Generic `UniversalRenderer` for one caller | Abstraction with no users | Build the concrete thing |
| Big-bang rewrite | Unreviewable, regression-prone | Incremental migration (§28) |

**Avoid premature abstraction.** Good: `<StatusBadge status="running" />`. Bad: `<UniversalRenderer strategy={…} adapter={…} resolver={…} />` when there is one caller. Wait for the second real use case.

---

## 32. Definition of done

A change is complete only when both **functional correctness** and **architectural maintainability** hold.

**Architecture**

- [ ] Correct feature directory and layer
- [ ] Single responsibility per module
- [ ] No cross-feature imports, no cycles
- [ ] Dependencies point downward

**Reuse**

- [ ] Existing components / hooks / services / utils / types reused
- [ ] No duplicated logic introduced
- [ ] Shared code promoted at the second use

**TypeScript**

- [ ] No unjustified `any`, no unsafe casts
- [ ] Domain types and branded IDs used
- [ ] Unions exhaustively handled

**UI**

- [ ] Tailwind used consistently; `cn()` for conditionals
- [ ] Radix for accessible primitives; Lucide for icons
- [ ] Theme variables only; verified in dark, light and high-contrast

**State**

- [ ] Local state stayed local
- [ ] Shared state normalised, actions exposed, selectors narrow
- [ ] One source of truth

**Streaming**

- [ ] Events processed centrally
- [ ] Duplicates, ordering, gaps, unknown types, version skew handled
- [ ] Reconnect and replay behave correctly
- [ ] UI updates incrementally and stays responsive

**Accessibility**

- [ ] Keyboard operable end to end
- [ ] Visible focus, managed focus
- [ ] Semantic HTML / ARIA where needed
- [ ] No colour-only status

**Errors and states**

- [ ] Every async path has a failure behaviour
- [ ] Loading / empty / error / disconnected all render
- [ ] Errors are actionable, logged with correlation IDs

**Performance**

- [ ] No unnecessary re-renders under stream load
- [ ] Large lists virtualised
- [ ] Bundle within budget

**Security**

- [ ] Inbound messages validated
- [ ] No secrets, no unsanitised HTML, no direct network calls

**Verification**

- [ ] Typecheck, lint, format, tests, production build all pass
- [ ] New tests cover the new logic and the bug being fixed
- [ ] ADR written if the decision is expensive to reverse

---

## 33. Golden rules

1. **Does this already exist?** Reuse before you build.
2. **Never solve the same problem twice.** Second occurrence → promote it.
3. **One source of truth.** Derive everything else.
4. **Events are the backbone.** One stream, one reducer, one store.
5. **Validate at every boundary.** Trust nothing that crossed one.
6. **Make the compiler enforce it** wherever a convention can become a type.
7. **Make the tooling enforce the rest.**
8. **Small components, clear boundaries, typed contracts, predictable state.**
9. **Ask not "how do I make this work" but "how do I make this work and stay understandable in six months".**
