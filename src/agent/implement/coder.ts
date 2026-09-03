import * as vscode from 'vscode';
import { AIModelProvider } from '../../ai/provider';
import { ChatMessage, ToolSpec } from '../../azureClient';
import { Settings } from '../../config';
import { EventBus } from '../../events/bus';
import { runTool, TOOL_SPECS, ToolContext } from '../../tools';
import { ChangeLog } from '../changes';
import { LockTable } from '../locks';
import { AgentRole, resolveRoleModel } from '../roles';
import { AgentScope, describeScope } from '../scope';
import { GitBaseline } from '../../git/baseline';

/** Rounds one implementation agent gets before it must stop. */
const MAX_CODER_ROUNDS = 16;

/**
 * What an implementation agent may call.
 *
 * `get_diagnostics` is included because it is the language server, so it is
 * instant and per-file — a coder that cannot see its own type errors will
 * hand the verifier work it could have caught itself.
 *
 * `run_validation` and `run_command` are deliberately absent. Four coders each
 * running the full test suite in parallel is slow, contends for the same
 * files, and edges towards agents certifying their own work. Running the
 * project's real checks is the verifier's job, once.
 */
const CODER_TOOLS = [
  'read_file',
  'list_files',
  'search_workspace',
  'apply_patch',
  'write_file',
  'get_diagnostics',
  'git_diff',
  'record_session'
];

export interface CoderOptions {
  objective: string;
  planBrief: string;
  request: string;
  scope?: AgentScope;
  role?: AgentRole;
  agentId: string;
  taskId: string;
  settings: Settings;
  provider: AIModelProvider;
  bus: EventBus;
  locks: LockTable;
  changes: ChangeLog;
  baseline?: GitBaseline;
  toolContext: Omit<
    ToolContext,
    'owner' | 'scope' | 'locks' | 'changes' | 'baseline' | 'taskId'
  >;
  signal: AbortSignal;
  token: vscode.CancellationToken;
  onUsage?: (usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  }) => void;
}

export type CoderOutcome =
  { ok: true; summary: string; filesChanged: string[] } | { ok: false; error: string };

function buildCoderPrompt(options: CoderOptions, base: string): string {
  const scopeText = describeScope(options.scope);
  const isRepair = options.role === 'repair';

  return `${base}

---

# Your task

You are ${isRepair ? 'a **Repair Agent**' : 'an **Implementation Agent**'} working as part of a coordinated run. Other agents are working on other parts of this task at the same time.

${options.planBrief}

---

## What you specifically must do

${options.objective}

## Your scope

You may modify: **${scopeText}**

You can read anything in the workspace — you will need to, to see the callers and types your change has to satisfy. But you may only *edit* the files above. If something outside your scope must change, say so clearly in your final message and stop; the Coordinator will assign it. Do not work around this, and do not ask the user.

## How to work

1. **Read before you edit.** Every file you are about to change, in full.
2. **Use \`apply_patch\`.** You are one of several agents; a whole-file \`write_file\` on an existing file can destroy work you cannot see. Reserve \`write_file\` for files you are creating.
3. **Check yourself** with \`get_diagnostics\` on what you touched.
4. **Stop when your part is done.** Do not expand into work another agent was assigned.

You cannot run tests or the build. An independent Verification Agent runs the project's real checks afterwards and will reject work that does not hold up, so there is nothing to gain from claiming more than you did.

When you are finished, reply with a short plain summary: what you changed, in which files, and anything you could not do. That message is your result — no other agent sees your tool calls.`;
}

/**
 * Runs one scoped implementation agent.
 *
 * The scope and the lock table are enforced inside the tools rather than by
 * this prompt, so an agent that decides to edit outside its lane is refused
 * regardless of what it was told. The prompt explains the rule; the tools are
 * what hold it.
 */
export async function runCoder(options: CoderOptions): Promise<CoderOutcome> {
  const tools: ToolSpec[] = TOOL_SPECS.filter((t) =>
    CODER_TOOLS.includes(t.function.name)
  );

  const role: AgentRole = options.role ?? 'coder';
  const model = resolveRoleModel(
    role,
    options.settings.modelRoles,
    options.settings.models,
    options.settings.deployment
  ).model;

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildCoderPrompt(options, `The user asked: "${options.request}"`)
    },
    { role: 'user', content: options.objective }
  ];

  let lastText = '';

  for (let round = 0; round < MAX_CODER_ROUNDS; round++) {
    if (options.token.isCancellationRequested) {
      return { ok: false, error: 'Cancelled.' };
    }

    let result;
    try {
      result = await options.provider.stream(
        { messages, tools, model, reasoningEffort: 'medium' },
        { onText: () => undefined },
        options.signal
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
    if (result.content) {
      lastText = result.content;
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
      const filesChanged = options.changes
        .byAgent(options.agentId)
        .filter((c) => c.applied)
        .map((c) => c.filePath);

      return {
        ok: true,
        summary: lastText.trim() || 'Finished without a summary.',
        filesChanged: [...new Set(filesChanged)]
      };
    }

    for (const call of result.toolCalls) {
      options.bus.emit({
        type: 'tool.started',
        taskId: options.taskId,
        agentId: options.agentId,
        data: { name: call.function.name }
      });

      const output = await runTool(call.function.name, call.function.arguments, {
        ...options.toolContext,
        owner: options.agentId,
        taskId: options.taskId,
        scope: options.scope,
        locks: options.locks,
        changes: options.changes,
        baseline: options.baseline
      });

      options.bus.emit({
        type: 'tool.completed',
        taskId: options.taskId,
        agentId: options.agentId,
        data: { name: call.function.name, preview: output.slice(0, 200) }
      });

      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }

  // Out of rounds. Anything it applied is real and stays; the verifier will
  // judge it. Reporting this as success would hide an unfinished task.
  const applied = options.changes
    .byAgent(options.agentId)
    .filter((c) => c.applied)
    .map((c) => c.filePath);

  return {
    ok: false,
    error:
      `Stopped after ${MAX_CODER_ROUNDS} rounds without finishing.` +
      (applied.length
        ? ` ${applied.length} file(s) were already changed: ${[...new Set(applied)].join(', ')}.`
        : ' No files were changed.')
  };
}
