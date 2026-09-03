import * as vscode from 'vscode';
import { AIModelProvider } from '../../ai/provider';
import { ChatMessage, ToolSpec } from '../../azureClient';
import { Settings } from '../../config';
import { EventBus } from '../../events/bus';
import { READ_ONLY_TOOLS } from '../mode';
import { resolveRoleModel } from '../roles';
import { runTool, TOOL_SPECS, ToolContext } from '../../tools';
import { parsePlan, SUBMIT_PLAN_TOOL } from './submitPlan';
import { buildPlannerPrompt } from './planners';
import { AgentPlan, PlannerSpec } from './types';

/** How many model rounds one planner gets before it must report. */
const MAX_PLANNER_ROUNDS = 8;

export interface PlannerRunOptions {
  planner: PlannerSpec;
  request: string;
  basePrompt: string;
  agentId: string;
  taskId: string;
  settings: Settings;
  provider: AIModelProvider;
  bus: EventBus;
  toolContext: Omit<ToolContext, 'owner'>;
  signal: AbortSignal;
  token: vscode.CancellationToken;
  /** Charged as each round returns, so the budget sees planning spend live. */
  onUsage?: (usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  }) => void;
}

export type PlannerResult =
  { ok: true; plan: AgentPlan } | { ok: false; error: string };

/**
 * Runs one planning agent to a structured plan.
 *
 * Separate from `ChatSession` on purpose. A chat session is a conversation
 * that persists, streams to the panel and can be resumed; a planner is a
 * one-shot analysis whose only output is a plan object. Sharing the loop would
 * mean bending each to the other's shape.
 *
 * The tool set is the read-only one Fast mode already uses, plus `submit_plan`.
 * A planner therefore *cannot* edit a file or run a mutating command — that is
 * enforced by what it is given, not by asking it nicely.
 */
export async function runPlanner(options: PlannerRunOptions): Promise<PlannerResult> {
  const {
    planner,
    request,
    basePrompt,
    agentId,
    taskId,
    settings,
    provider,
    bus,
    toolContext,
    signal,
    token
  } = options;

  const tools: ToolSpec[] = [
    ...TOOL_SPECS.filter((t) => READ_ONLY_TOOLS.includes(t.function.name)),
    SUBMIT_PLAN_TOOL
  ];

  const model = resolveRoleModel(
    'planner',
    settings.modelRoles,
    settings.models,
    settings.deployment
  ).model;

  const messages: ChatMessage[] = [
    { role: 'system', content: buildPlannerPrompt(planner, request, basePrompt) },
    {
      role: 'user',
      content: `Analyse this request from your assigned angle, then call submit_plan.\n\n${request}`
    }
  ];

  bus.emit({
    type: 'planning.agent.started',
    taskId,
    agentId,
    data: { planner: planner.id, label: planner.label, model }
  });

  for (let round = 0; round < MAX_PLANNER_ROUNDS; round++) {
    if (token.isCancellationRequested) {
      return { ok: false, error: 'Cancelled.' };
    }

    let result;
    try {
      result = await provider.stream(
        // Planners are analysis, not narration: their prose is not streamed to
        // the panel, only their progress events and the plan they submit.
        { messages, tools, model, reasoningEffort: 'low' },
        { onText: () => undefined },
        signal
      );
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        return { ok: false, error: 'Cancelled.' };
      }
      return { ok: false, error: (err as Error).message };
    }

    if (result.usage) {
      options.onUsage?.(result.usage);
    }

    const assistant: ChatMessage = {
      role: 'assistant',
      content: result.content || null
    };
    if (result.toolCalls.length > 0) {
      assistant.tool_calls = result.toolCalls;
    }
    messages.push(assistant);

    if (result.toolCalls.length === 0) {
      // It stopped without submitting. Ask once, plainly, then give up rather
      // than looping a model that has decided it is finished.
      if (round === MAX_PLANNER_ROUNDS - 1) {
        return {
          ok: false,
          error: `${planner.label} finished without calling submit_plan.`
        };
      }
      messages.push({
        role: 'user',
        content:
          'You have not submitted a plan yet. Call submit_plan now with what you found, even if your confidence is low.'
      });
      continue;
    }

    const submission = result.toolCalls.find(
      (c) => c.function.name === SUBMIT_PLAN_TOOL.function.name
    );

    // Run the inspection tools first, so a round that both reads and submits
    // still has its reads recorded.
    for (const call of result.toolCalls) {
      if (call === submission) {
        continue;
      }
      bus.emit({
        type: 'tool.started',
        taskId,
        agentId,
        data: { name: call.function.name, planner: planner.id }
      });
      const output = await runTool(call.function.name, call.function.arguments, {
        ...toolContext,
        owner: agentId
      });
      bus.emit({
        type: 'tool.completed',
        taskId,
        agentId,
        data: { name: call.function.name, preview: output.slice(0, 200) }
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }

    if (submission) {
      const parsed = parsePlan(submission.function.arguments, {
        agentId,
        role: 'planner',
        planner: planner.id,
        objective: planner.label
      });

      if (!parsed.ok) {
        // Feed the complaint back once; a malformed call is usually recoverable.
        messages.push({
          role: 'tool',
          tool_call_id: submission.id,
          content: `Error: ${parsed.error} Call submit_plan again with valid arguments.`
        });
        continue;
      }

      bus.emit({
        type: 'planning.agent.completed',
        taskId,
        agentId,
        data: {
          planner: planner.id,
          label: planner.label,
          confidence: parsed.plan.confidence,
          files: parsed.plan.relevantFiles.length,
          changes: parsed.plan.proposedChanges.length
        }
      });
      return { ok: true, plan: parsed.plan };
    }
  }

  return {
    ok: false,
    error: `${planner.label} did not produce a plan within ${MAX_PLANNER_ROUNDS} rounds.`
  };
}
