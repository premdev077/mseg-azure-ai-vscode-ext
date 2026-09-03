import type { ReasoningEffort } from '../ai/reasoning';
import { PromptTier } from '../prompt/systemPrompt';

/**
 * How much machinery a turn is allowed to use.
 *
 * The three modes are not three agents — they are one loop with different
 * budgets. `agent` is the loop this extension already had; `thinking` is the
 * same loop with a narrower prompt and no auto-fix; `fast` restricts it to
 * read-only tools and the core prompt so a "what does this function do"
 * question does not pay for 11k tokens of engineering standards.
 */
export type AgentMode = 'fast' | 'thinking' | 'agent';

export const AGENT_MODES: readonly AgentMode[] = ['fast', 'thinking', 'agent'];

export function isAgentMode(value: unknown): value is AgentMode {
  return value === 'fast' || value === 'thinking' || value === 'agent';
}

/** Tools that only inspect. Fast mode is limited to these. */
export const READ_ONLY_TOOLS: readonly string[] = [
  'read_file',
  'list_files',
  'search_workspace',
  'get_diagnostics',
  'git_status',
  'git_diff'
];

export interface ModeProfile {
  mode: AgentMode;
  label: string;
  /** Shown in the composer's tooltip and the settings description. */
  description: string;
  /** Prompt sections this mode loads. */
  tiers: readonly PromptTier[];
  /**
   * Tool allowlist. `undefined` means every registered tool, which is what
   * `agent` and `thinking` get.
   */
  allowedTools?: readonly string[];
  /**
   * Extra ceiling on tool rounds, applied on top of
   * `azureAiChat.maxToolIterations` — the lower of the two wins, so raising
   * the setting never makes Fast mode grind.
   */
  toolRoundCap?: number;
  /** Used only when the composer's Thinking selector is left on Default. */
  defaultReasoningEffort?: ReasoningEffort;
  /** Whether the verify → analyse → fix → verify loop runs after edits. */
  autoFix: boolean;
  /** Appended to the system prompt so the model knows its budget. */
  guidance: string;
}

const FAST: ModeProfile = {
  mode: 'fast',
  label: 'Fast',
  description:
    'Explanations, lookups and small snippets. Read-only tools, minimal reasoning.',
  tiers: ['core'],
  allowedTools: READ_ONLY_TOOLS,
  toolRoundCap: 3,
  defaultReasoningEffort: 'minimal',
  autoFix: false,
  guidance: `# Mode: Fast

This turn is for a quick answer: explaining code, locating a symbol, answering a technical question, or producing a small snippet.

- You have read-only tools only. You cannot edit files or run commands this turn.
- Read at most a few files. Do not survey the repository.
- Answer directly and briefly. Skip the plan and the engineering summary.
- If the request actually needs edits, commands or investigation, say so in one line and tell the user to re-send it in Thinking or Agent mode. Do not attempt it with read-only tools.`
};

const THINKING: ModeProfile = {
  mode: 'thinking',
  label: 'Thinking',
  description:
    'Complex changes. Inspects the repository, plans, implements and verifies. Accuracy over speed.',
  tiers: ['core', 'deep', 'session'],
  defaultReasoningEffort: 'medium',
  autoFix: false,
  guidance: `# Mode: Thinking

This turn is for a change that deserves care. Prioritise correctness over speed.

Work in this order:

1. **Understand** — state what is being asked and what the result should be.
2. **Inspect** — use the workspace tools to find the existing implementation, its dependencies and its tests. Do not start editing until you have the context.
3. **Plan** — set out the steps briefly before you change anything.
4. **Implement** — the smallest targeted change that solves it.
5. **Verify** — \`get_diagnostics\` on what you touched, then \`run_validation\`.
6. **Review** — \`git_diff\` before you report.

Report what you found, what you changed, and what you actually verified. If a check failed, say so and say why.`
};

const AGENT: ModeProfile = {
  mode: 'agent',
  label: 'Agent',
  description:
    'Completes the task end to end: inspects, plans, edits, runs checks and fixes failures.',
  tiers: ['core', 'deep', 'session', 'stack'],
  defaultReasoningEffort: 'high',
  autoFix: true,
  guidance: `# Mode: Agent

Complete the task end to end. You are expected to finish, not to hand back a plan.

1. **Understand** the request and the expected result.
2. **Discover context** — find the relevant files, symbols, dependencies, tests and configuration before changing anything.
3. **Check for uncommitted work** with \`git_status\`, so you never overwrite changes you did not make.
4. **Plan** the implementation.
5. **Implement** with targeted edits.
6. **Verify** — \`get_diagnostics\`, then \`run_validation\`.
7. **Fix** failures: read the error, locate the cause, understand it, fix it, re-run. Do not stop at the first failure, and do not silence an error to make a check pass.
8. **Review** \`git_diff\` and report.

If you cannot safely finish, stop and say so plainly: what remains broken, which files you changed, and which checks you ran. Never report success for something you did not verify.`
};

export const MODE_PROFILES: Readonly<Record<AgentMode, ModeProfile>> = {
  fast: FAST,
  thinking: THINKING,
  agent: AGENT
};

export function modeProfile(mode: AgentMode): ModeProfile {
  return MODE_PROFILES[mode];
}
