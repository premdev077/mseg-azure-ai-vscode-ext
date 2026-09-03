import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { Budget } from '../agent/budget';
import { Coordinator } from '../agent/coordinator';
import { LockTable } from '../agent/locks';
import { DEFAULT_CONCURRENCY, runGraph } from '../agent/scheduler';
import { TaskGraph } from '../agent/taskGraph';
import { EventBus } from '../events/bus';

const NEVER_CANCELLED = { isCancellationRequested: false };

function graphOf(
  ...nodes: Array<{ id: string; deps?: string[]; role?: string; priority?: string }>
): TaskGraph {
  const graph = new TaskGraph();
  for (const n of nodes) {
    graph.add({
      id: n.id,
      objective: `do ${n.id}`,
      role: (n.role ?? 'coder') as never,
      priority: (n.priority ?? 'normal') as never,
      dependencies: n.deps
    });
  }
  return graph;
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

// --- graph validation ------------------------------------------------------

test('a valid graph returns a topological order', () => {
  const graph = graphOf(
    { id: 'a' },
    { id: 'b', deps: ['a'] },
    { id: 'c', deps: ['b'] }
  );
  const result = graph.validate();
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.order, ['a', 'b', 'c']);
});

test('a dependency cycle is refused, naming the tasks involved', () => {
  const graph = graphOf(
    { id: 'a', deps: ['c'] },
    { id: 'b', deps: ['a'] },
    { id: 'c', deps: ['b'] }
  );
  const result = graph.validate();
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /cycle/i);
  assert.match(result.ok ? '' : result.error, /a, b, c/);
});

test('a dependency on a task that does not exist is refused', () => {
  const graph = graphOf({ id: 'a', deps: ['ghost'] });
  const result = graph.validate();
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /"ghost", which does not exist/);
});

test('a self-dependency is refused', () => {
  const graph = graphOf({ id: 'a', deps: ['a'] });
  assert.equal(graph.validate().ok, false);
});

test('duplicate task ids are rejected at insertion', () => {
  const graph = graphOf({ id: 'a' });
  assert.throws(
    () => graph.add({ id: 'a', objective: 'again', role: 'coder' }),
    /Duplicate/
  );
});

// --- readiness and priority ------------------------------------------------

test('only tasks whose dependencies succeeded are ready', () => {
  const graph = graphOf({ id: 'a' }, { id: 'b' }, { id: 'c', deps: ['a', 'b'] });

  assert.deepEqual(
    graph.ready().map((n) => n.id),
    ['a', 'b']
  );

  graph.markRunning('a');
  graph.markSucceeded('a');
  assert.deepEqual(
    graph.ready().map((n) => n.id),
    ['b'],
    'c still waits on b'
  );

  graph.markRunning('b');
  graph.markSucceeded('b');
  assert.deepEqual(
    graph.ready().map((n) => n.id),
    ['c']
  );
});

test('higher priority is scheduled first, ties broken stably', () => {
  const graph = graphOf(
    { id: 'z-low', priority: 'low' },
    { id: 'a-normal', priority: 'normal' },
    { id: 'm-critical', priority: 'critical' },
    { id: 'b-normal', priority: 'normal' },
    { id: 'k-high', priority: 'high' }
  );
  assert.deepEqual(
    graph.ready().map((n) => n.id),
    ['m-critical', 'k-high', 'a-normal', 'b-normal', 'z-low']
  );
});

test('blockedBy answers why a task has not started', () => {
  const graph = graphOf({ id: 'a' }, { id: 'b' }, { id: 'c', deps: ['a', 'b'] });
  assert.deepEqual(graph.blockedBy('c').sort(), ['a', 'b']);

  graph.markRunning('a');
  graph.markSucceeded('a');
  assert.deepEqual(graph.blockedBy('c'), ['b']);
  assert.deepEqual(graph.blockedBy('a'), [], 'a settled task is not blocked');
});

test('a failure skips dependents transitively rather than leaving them pending', () => {
  const graph = graphOf(
    { id: 'a' },
    { id: 'b', deps: ['a'] },
    { id: 'c', deps: ['b'] },
    { id: 'unrelated' }
  );
  graph.markRunning('a');
  const skipped = graph.markFailed('a', 'boom');

  assert.deepEqual(skipped.sort(), ['b', 'c']);
  assert.equal(graph.get('unrelated')?.state, 'pending', 'unrelated work is untouched');
  assert.match(String(graph.get('c')?.error), /depends on did not succeed/);
});

// --- scheduling ------------------------------------------------------------

test('independent tasks run concurrently', async () => {
  const graph = graphOf({ id: 'a' }, { id: 'b' }, { id: 'c' });
  let inFlight = 0;
  let peak = 0;
  const gate = deferred();

  const run = runGraph(
    graph,
    new Budget(),
    DEFAULT_CONCURRENCY,
    {
      run: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await gate.promise;
        inFlight -= 1;
        return { ok: true };
      }
    },
    NEVER_CANCELLED
  );

  // All three should be in flight before any of them is allowed to finish.
  await new Promise((r) => setImmediate(r));
  assert.equal(peak, 3, 'independent tasks should have started together');

  gate.resolve();
  const result = await run;
  assert.equal(result.ok, true);
  assert.equal(result.succeeded, 3);
});

test('a dependent task waits for its dependency', async () => {
  const graph = graphOf({ id: 'first' }, { id: 'second', deps: ['first'] });
  const order: string[] = [];

  const result = await runGraph(
    graph,
    new Budget(),
    DEFAULT_CONCURRENCY,
    {
      run: async (node) => {
        order.push(`start:${node.id}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end:${node.id}`);
        return { ok: true };
      }
    },
    NEVER_CANCELLED
  );

  assert.equal(result.ok, true);
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);
});

test('the global concurrency limit is respected', async () => {
  const graph = graphOf(...Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` })));
  let inFlight = 0;
  let peak = 0;

  await runGraph(
    graph,
    new Budget(),
    { ...DEFAULT_CONCURRENCY, maxConcurrentAgents: 3 },
    {
      run: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return { ok: true };
      }
    },
    NEVER_CANCELLED
  );

  assert.ok(peak <= 3, `peak concurrency was ${peak}, limit was 3`);
  assert.equal(graph.counts().succeeded, 10);
});

test('a per-role limit applies on top of the global one', async () => {
  const graph = graphOf(
    ...Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, role: 'planner' }))
  );
  let inFlight = 0;
  let peak = 0;

  await runGraph(
    graph,
    new Budget(),
    {
      maxConcurrentAgents: 10,
      maxPlanningAgents: 2,
      maxCodingAgents: 4,
      maxRepairAgents: 3
    },
    {
      run: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return { ok: true };
      }
    },
    NEVER_CANCELLED
  );

  assert.ok(peak <= 2, `planner concurrency was ${peak}, limit was 2`);
});

test('a throwing runner fails its node instead of taking down the run', async () => {
  const graph = graphOf({ id: 'good' }, { id: 'bad' });

  const result = await runGraph(
    graph,
    new Budget(),
    DEFAULT_CONCURRENCY,
    {
      run: async (node) => {
        if (node.id === 'bad') {
          throw new Error('runner exploded');
        }
        return { ok: true };
      }
    },
    NEVER_CANCELLED
  );

  assert.equal(result.ok, false);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.match(String(graph.get('bad')?.error), /runner exploded/);
});

test('cancellation stops new work but lets in-flight work finish', async () => {
  const graph = graphOf(
    { id: 'a' },
    { id: 'b', deps: ['a'] },
    { id: 'c', deps: ['a'] }
  );
  const signal = { isCancellationRequested: false };
  let finished = 0;

  const result = await runGraph(
    graph,
    new Budget(),
    DEFAULT_CONCURRENCY,
    {
      run: async () => {
        signal.isCancellationRequested = true;
        await new Promise((r) => setTimeout(r, 5));
        finished += 1;
        return { ok: true };
      }
    },
    signal
  );

  assert.equal(finished, 1, 'the running task should have been allowed to finish');
  assert.equal(result.cancelled, 2, 'the two dependents should be cancelled');
  assert.match(String(result.stoppedEarly), /cancelled/i);
});

test('the scheduler refuses an invalid graph rather than stalling', async () => {
  const graph = graphOf({ id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] });
  await assert.rejects(
    () =>
      runGraph(graph, new Budget(), DEFAULT_CONCURRENCY, {
        run: async () => ({ ok: true })
      }),
    /cycle/i
  );
});

// --- budget ----------------------------------------------------------------

test('the token budget stops new agents starting', async () => {
  const graph = graphOf(...Array.from({ length: 6 }, (_, i) => ({ id: `t${i}` })));
  const budget = new Budget({ maxTotalTokens: 100 });
  let stopReason = '';

  const result = await runGraph(
    graph,
    budget,
    { ...DEFAULT_CONCURRENCY, maxConcurrentAgents: 1 },
    {
      run: async () => {
        budget.charge({ prompt_tokens: 60, completion_tokens: 10 });
        return { ok: true };
      },
      onBudgetExhausted: (reason) => {
        stopReason = reason;
      }
    },
    NEVER_CANCELLED
  );

  assert.ok(result.succeeded < 6, 'the budget should have cut the run short');
  assert.match(stopReason, /budget of 100 tokens/);
  assert.match(String(result.stoppedEarly), /budget/);
});

test('the agent-count limit is enforced independently of tokens', () => {
  const budget = new Budget({ maxAgents: 2 });
  budget.noteAgentStarted();
  budget.noteAgentStarted();

  const verdict = budget.canStartAgent();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok ? '' : verdict.exhausted, 'agents');
});

test('the wall-clock limit is enforced', () => {
  let now = 0;
  const budget = new Budget({ totalTaskTimeoutMs: 1000 }, () => now);
  assert.equal(budget.canStartAgent().ok, true);

  now = 1500;
  const verdict = budget.canStartAgent();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok ? '' : verdict.exhausted, 'time');
  assert.equal(budget.remainingMs, 0, 'remaining time never goes negative');
});

test('usage accumulates prompt, completion and reasoning tokens', () => {
  const budget = new Budget();
  budget.charge({ prompt_tokens: 100, completion_tokens: 20 });
  budget.charge({
    prompt_tokens: 50,
    completion_tokens: 10,
    completion_tokens_details: { reasoning_tokens: 7 }
  });

  const usage = budget.usage();
  assert.equal(usage.promptTokens, 150);
  assert.equal(usage.completionTokens, 30);
  assert.equal(usage.reasoningTokens, 7);
  assert.equal(usage.totalTokens, 180);
});

// --- file locks ------------------------------------------------------------

test('two agents cannot hold the same file at once', () => {
  const locks = new LockTable();
  const first = locks.tryAcquire('src/auth.ts', 'task1', 'coder-a');
  const second = locks.tryAcquire('src/auth.ts', 'task1', 'coder-b');

  assert.ok(first, 'the first agent should get the lock');
  assert.equal(second, undefined, 'the second agent must be refused');
  assert.equal(locks.holder('src/auth.ts')?.agentId, 'coder-a');
});

test('lock keys are normalised so one file cannot be held twice', () => {
  const locks = new LockTable();
  assert.ok(locks.tryAcquire('src/Auth.ts', 't', 'a'));
  assert.equal(locks.tryAcquire('src\\auth.ts', 't', 'b'), undefined);
  assert.equal(locks.tryAcquire('./src/AUTH.ts', 't', 'c'), undefined);
});

test('the same agent may re-acquire a file it already holds', () => {
  const locks = new LockTable();
  locks.tryAcquire('src/auth.ts', 't', 'coder-a');
  assert.ok(
    locks.tryAcquire('src/auth.ts', 't', 'coder-a'),
    'an agent patching one file twice must not deadlock against itself'
  );
});

test('a waiting agent receives the lock when the holder releases', async () => {
  const locks = new LockTable();
  locks.tryAcquire('src/auth.ts', 't', 'coder-a');

  const waiting = locks.acquire('src/auth.ts', 't', 'coder-b');
  assert.deepEqual(locks.waiting('src/auth.ts'), ['coder-b']);

  locks.release('src/auth.ts', 'coder-a');
  const grant = await waiting;
  assert.equal(grant.lock.agentId, 'coder-b');
  assert.equal(locks.holder('src/auth.ts')?.agentId, 'coder-b');
});

test('only the holder can release a lock', () => {
  const locks = new LockTable();
  locks.tryAcquire('src/auth.ts', 't', 'coder-a');

  assert.equal(locks.release('src/auth.ts', 'coder-b'), false);
  assert.equal(
    locks.holder('src/auth.ts')?.agentId,
    'coder-a',
    'the lock must still be held'
  );
});

test('cancelling an agent frees its locks rather than orphaning them', () => {
  const locks = new LockTable();
  locks.tryAcquire('src/a.ts', 't', 'coder-a');
  locks.tryAcquire('src/b.ts', 't', 'coder-a');
  locks.tryAcquire('src/c.ts', 't', 'coder-b');

  const released = locks.releaseAll('coder-a');
  assert.deepEqual(released.sort(), ['src/a.ts', 'src/b.ts']);
  assert.equal(locks.holder('src/a.ts'), undefined);
  assert.equal(
    locks.holder('src/c.ts')?.agentId,
    'coder-b',
    "another agent's lock survives"
  );
});

test('a cancelled waiter is rejected instead of waiting forever', async () => {
  const locks = new LockTable();
  locks.tryAcquire('src/auth.ts', 't', 'coder-a');
  const waiting = locks.acquire('src/auth.ts', 't', 'coder-b');

  locks.releaseAll('coder-b');
  await assert.rejects(() => waiting, /cancelled while waiting/);
});

// --- coordinator -----------------------------------------------------------

test('the coordinator runs a single-node graph and reports it', async () => {
  const bus = new EventBus();
  const coordinator = new Coordinator({ bus, taskId: 'task-1' });
  coordinator.addTask({ id: 'chat', objective: 'answer the user', role: 'chat' });

  const outcome = await coordinator.run(async () => ({ ok: true }));

  assert.equal(outcome.succeeded, 1);
  assert.equal(outcome.failed, 0);
  // Success is "changes ready", not "completed": only the verifier may complete.
  assert.equal(outcome.state, 'changes_ready');
});

test('a clean run never reports completed on its own authority', async () => {
  const bus = new EventBus();
  const coordinator = new Coordinator({ bus, taskId: 'task-1' });
  coordinator.addTask({ id: 'a', objective: 'work', role: 'coder' });

  const outcome = await coordinator.run(async () => ({ ok: true }));
  assert.notEqual(outcome.state, 'completed', 'agents must not self-certify');
});

test('the coordinator emits a traceable lifecycle', async () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.on((e) => seen.push(e.type));

  const coordinator = new Coordinator({ bus, taskId: 'task-1' });
  coordinator.addTask({ id: 'a', objective: 'work', role: 'coder' });
  await coordinator.run(async () => ({ ok: true }));

  assert.ok(seen.includes('task.created'));
  assert.ok(seen.includes('agent.created'));
  assert.ok(seen.includes('agent.started'));
  assert.ok(seen.includes('agent.completed'));
});

test('every agent event carries the agent id that caused it', async () => {
  const bus = new EventBus();
  const started: Array<string | undefined> = [];
  bus.on((e) => {
    if (e.type === 'agent.started') {
      started.push(e.agentId);
    }
  });

  const coordinator = new Coordinator({ bus, taskId: 'task-1' });
  coordinator.addTask({ id: 'a', objective: 'work', role: 'coder' });
  coordinator.addTask({ id: 'b', objective: 'work', role: 'planner' });
  await coordinator.run(async () => ({ ok: true }));

  assert.equal(started.length, 2);
  assert.ok(started.every((id) => typeof id === 'string' && id.length > 0));
  assert.equal(new Set(started).size, 2, 'agent ids must be distinct');
  // The registry answers "which agent ran which task".
  assert.equal(coordinator.agents().length, 2);
});

test('locks are released when an agent throws', async () => {
  const bus = new EventBus();
  const coordinator = new Coordinator({ bus, taskId: 'task-1' });
  coordinator.addTask({ id: 'a', objective: 'work', role: 'coder' });

  await coordinator.run(async (ctx) => {
    ctx.locks.tryAcquire('src/auth.ts', ctx.taskId, ctx.agentId);
    throw new Error('agent died holding a lock');
  });

  assert.deepEqual(coordinator.locks.active(), [], 'no lock may outlive its agent');
});

test('a failing agent marks the run failed and skips its dependents', async () => {
  const bus = new EventBus();
  const coordinator = new Coordinator({ bus, taskId: 'task-1' });
  coordinator.addTask({ id: 'a', objective: 'work', role: 'coder' });
  coordinator.addTask({
    id: 'b',
    objective: 'depends',
    role: 'coder',
    dependencies: ['a']
  });

  const outcome = await coordinator.run(async (ctx) =>
    ctx.node.id === 'a' ? { ok: false, error: 'no' } : { ok: true }
  );

  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.failed, 1);
  assert.equal(outcome.skipped, 1);
});

test('an invalid graph fails the run with the reason, without calling any agent', async () => {
  const bus = new EventBus();
  const coordinator = new Coordinator({ bus, taskId: 'task-1' });
  coordinator.addTask({
    id: 'a',
    objective: 'work',
    role: 'coder',
    dependencies: ['nope']
  });

  let called = false;
  const outcome = await coordinator.run(async () => {
    called = true;
    return { ok: true };
  });

  assert.equal(called, false);
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.summary, /does not exist/);
});
