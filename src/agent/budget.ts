/**
 * What a run is allowed to spend.
 *
 * Counting agents is not enough on this deployment. Agent mode's system prompt
 * alone is roughly 12k tokens, so five "concurrent agents" is ~60k prompt
 * tokens before any work happens — and they all draw on one Azure deployment's
 * TPM quota. A limiter that only counts agents would let five wide agents
 * through and be throttled, while refusing six narrow ones that would have been
 * fine. So tokens are the real currency here, and the agent count is a
 * secondary guard.
 */
export interface BudgetLimits {
  /** Total prompt + completion tokens across the whole run. */
  maxTotalTokens: number;
  /** How many agents may ever be created for one run. */
  maxAgents: number;
  /** Wall-clock ceiling for the whole run. */
  totalTaskTimeoutMs: number;
  /** Ceiling for any single agent. */
  agentTimeoutMs: number;
}

export const DEFAULT_BUDGET: BudgetLimits = {
  maxTotalTokens: 500_000,
  maxAgents: 20,
  totalTaskTimeoutMs: 15 * 60_000,
  agentTimeoutMs: 5 * 60_000
};

export interface BudgetUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  agentsStarted: number;
  elapsedMs: number;
}

export type BudgetVerdict =
  { ok: true } | { ok: false; reason: string; exhausted: 'tokens' | 'agents' | 'time' };

/**
 * Tracks spend for one run.
 *
 * Deliberately advisory rather than enforcing: it says whether another agent
 * may start, and the Coordinator decides what to do about it. Work already in
 * flight is never killed for going over — the brief's rule is "stop new agents,
 * finish critical work, run verification, report the limitation", which is only
 * possible if exceeding the budget is a signal rather than a hard stop.
 */
export class Budget {
  private prompt = 0;
  private completion = 0;
  private reasoning = 0;
  private agents = 0;
  private readonly startedAt: number;
  private readonly limits: BudgetLimits;
  private readonly clock: () => number;

  constructor(limits: Partial<BudgetLimits> = {}, clock: () => number = Date.now) {
    this.limits = { ...DEFAULT_BUDGET, ...limits };
    this.clock = clock;
    this.startedAt = clock();
  }

  get configured(): BudgetLimits {
    return { ...this.limits };
  }

  charge(usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  }): void {
    this.prompt += usage.prompt_tokens ?? 0;
    this.completion += usage.completion_tokens ?? 0;
    this.reasoning += usage.completion_tokens_details?.reasoning_tokens ?? 0;
  }

  /** Called when an agent is actually started, not when it is planned. */
  noteAgentStarted(): void {
    this.agents += 1;
  }

  usage(): BudgetUsage {
    return {
      promptTokens: this.prompt,
      completionTokens: this.completion,
      reasoningTokens: this.reasoning,
      totalTokens: this.prompt + this.completion,
      agentsStarted: this.agents,
      elapsedMs: this.clock() - this.startedAt
    };
  }

  get elapsedMs(): number {
    return this.clock() - this.startedAt;
  }

  /** Time left before the run's wall-clock ceiling. Never negative. */
  get remainingMs(): number {
    return Math.max(0, this.limits.totalTaskTimeoutMs - this.elapsedMs);
  }

  /**
   * Whether another agent may start. Checked before each one, so a run winds
   * down at a boundary rather than being cut off mid-tool-call.
   */
  canStartAgent(): BudgetVerdict {
    const used = this.usage();

    if (used.elapsedMs >= this.limits.totalTaskTimeoutMs) {
      return {
        ok: false,
        exhausted: 'time',
        reason: `The run reached its ${Math.round(
          this.limits.totalTaskTimeoutMs / 1000
        )}s time limit. No further agents were started.`
      };
    }
    if (used.agentsStarted >= this.limits.maxAgents) {
      return {
        ok: false,
        exhausted: 'agents',
        reason: `The run reached its limit of ${this.limits.maxAgents} agents. No further agents were started.`
      };
    }
    if (used.totalTokens >= this.limits.maxTotalTokens) {
      return {
        ok: false,
        exhausted: 'tokens',
        reason: `The run reached its budget of ${this.limits.maxTotalTokens.toLocaleString()} tokens (used ${used.totalTokens.toLocaleString()}). No further agents were started.`
      };
    }
    return { ok: true };
  }

  /** One line for the session report. */
  describe(): string {
    const used = this.usage();
    return [
      `${used.totalTokens.toLocaleString()} tokens `,
      `(${used.promptTokens.toLocaleString()} in, ${used.completionTokens.toLocaleString()} out`,
      used.reasoningTokens
        ? `, ${used.reasoningTokens.toLocaleString()} reasoning)`
        : ')',
      ` · ${used.agentsStarted} agent(s)`,
      ` · ${(used.elapsedMs / 1000).toFixed(1)}s`
    ].join('');
  }
}
