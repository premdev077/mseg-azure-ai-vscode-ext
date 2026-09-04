import type { AgentEvent } from '../../../src/events/types';
import {
  asAgentId,
  asEventId,
  asTaskId,
  EVENT_VERSION
} from '../../../src/events/types';

/**
 * A realistic multi-agent run, for looking at the UI without an Azure key.
 *
 * Development only — `preview.html` is not an input to the production build,
 * so none of this ships.
 */
let seq = 0;

function ev(type: string, data: unknown, agentId?: string): AgentEvent {
  seq += 1;
  return {
    eventId: asEventId(`p-${seq}`),
    eventVersion: EVENT_VERSION,
    taskId: asTaskId('preview'),
    agentId: agentId ? asAgentId(agentId) : undefined,
    type,
    timestamp: new Date(Date.now() - (200 - seq) * 900).toISOString(),
    sequence: seq,
    data
  } as AgentEvent;
}

export function midRunEvents(): AgentEvent[] {
  return [
    ev('task.started', { mode: 'multi-agent' }),
    ev('planning.started', {
      planners: ['repository', 'architecture', 'dependencies', 'testing', 'security'],
      count: 5
    }),
    ev(
      'planning.agent.started',
      { planner: 'repository', label: 'Repository', model: 'luna' },
      'plan-repository'
    ),
    ev(
      'planning.agent.started',
      { planner: 'architecture', label: 'Architecture', model: 'luna' },
      'plan-architecture'
    ),
    ev(
      'planning.agent.started',
      { planner: 'testing', label: 'Testing', model: 'luna' },
      'plan-testing'
    ),
    ev(
      'tool.started',
      { name: 'search_workspace', args: '/oauth/' },
      'plan-repository'
    ),
    ev(
      'tool.completed',
      { name: 'search_workspace', preview: '14 match(es) for /oauth/' },
      'plan-repository'
    ),
    ev(
      'tool.started',
      { name: 'read_file', args: 'src/auth/callback.ts' },
      'plan-repository'
    ),
    ev(
      'tool.completed',
      { name: 'read_file', preview: 'src/auth/callback.ts (86 lines)' },
      'plan-repository'
    ),
    ev(
      'planning.agent.completed',
      {
        planner: 'repository',
        label: 'Repository',
        confidence: 0.92,
        files: 6,
        changes: 2
      },
      'plan-repository'
    ),
    ev(
      'planning.agent.completed',
      {
        planner: 'architecture',
        label: 'Architecture',
        confidence: 0.8,
        files: 4,
        changes: 1
      },
      'plan-architecture'
    ),
    ev('planning.completed', {
      plans: 4,
      failed: 1,
      files: 8,
      changes: 3,
      conflicts: 1,
      confidence: 0.86,
      proceed: true
    }),
    ev('agent.created', { nodeId: 'implement-1', role: 'coder', waitedOn: [] }),
    ev('agent.created', {
      nodeId: 'implement-2',
      role: 'coder',
      waitedOn: ['implement-1']
    }),
    ev(
      'agent.started',
      {
        nodeId: 'implement-1',
        role: 'coder',
        objective: 'Update the OAuth callback to validate its token'
      },
      'implement-1'
    ),
    ev(
      'tool.started',
      { name: 'apply_patch', args: 'src/auth/callback.ts' },
      'implement-1'
    ),
    ev(
      'file.edit.proposed',
      {
        id: 'e1',
        relPath: 'src/auth/callback.ts',
        added: 24,
        removed: 6,
        isNewFile: false
      },
      'implement-1'
    ),
    ev(
      'tool.completed',
      { name: 'apply_patch', preview: '1 edit(s) applied to src/auth/callback.ts' },
      'implement-1'
    ),
    ev('file.edit.resolved', { id: 'e1', decision: 'accepted' }),
    ev(
      'file.edit.proposed',
      {
        id: 'e2',
        relPath: 'tests/auth.callback.test.ts',
        added: 58,
        removed: 0,
        isNewFile: true
      },
      'implement-1'
    ),
    ev('command.proposed', {
      id: 'c1',
      command: 'npm run type-check',
      cwd: '/repo',
      reason: "runs the project's own checks",
      autoRun: false
    }),
    ev('model.text', {
      delta:
        "I inspected the OAuth callback and found the token is used without validation.\n\nI'll add a `validateToken` step before the session is created, then cover it with a test.\n\n"
    }),
    ev('model.text', {
      delta:
        '```ts\nconst token = await validateToken(response.token);\nif (!token.valid) {\n  throw new AuthError("Callback token failed validation");\n}\n```\n\n'
    }),
    ev('model.text', { delta: 'Waiting on the type-check before I report.' }),
    ev('verification.started', { attempt: 1, model: 'terra', files: 2 })
  ];
}

export function verifiedEvents(): AgentEvent[] {
  return [
    ...midRunEvents(),
    ev('verification.completed', {
      attempt: 1,
      passed: true,
      tests: 'passed',
      typecheck: 'passed',
      lint: 'passed',
      build: 'skipped',
      issues: 0,
      fixes: 0
    }),
    ev('model.completed', { usageNote: '18,420 tokens (2,110 reasoning)' }),
    ev('task.completed', { state: 'completed' })
  ];
}
