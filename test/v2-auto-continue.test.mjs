import assert from 'node:assert/strict';
import test from 'node:test';

import { validateDecision } from '../lib/contracts/decision.mjs';
import { FakeExecutor } from '../lib/executors/fake.mjs';
import { ExecutorRegistry } from '../lib/executors/registry.mjs';
import { ScriptedDecisionRunner } from '../lib/orchestrator/decision-runner.mjs';
import { buildBoundedStatePacket } from '../lib/orchestrator/state-packet.mjs';
import { WorkflowDaemon } from '../lib/runtime/daemon.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

function delegatedScope(objective = 'Run the failing tests and return evidence') {
  return {
    objective,
    required_capabilities: ['local.shell', 'local.test'],
    allowed_changes: ['docs/agent-results/T-304.json'],
    forbidden_changes: ['src/**'],
    validation: ['npm test'],
    return: ['exit_status', 'test_output', 'artifacts']
  };
}

function task() {
  return {
    id: 'T-304',
    objective: 'Make the full validation suite pass',
    required_capabilities: ['reasoning', 'local.shell', 'local.test'],
    allowed_changes: ['docs/agent-results/T-304.json'],
    forbidden_changes: ['src/**'],
    acceptance_criteria: ['npm test passes'],
    delegated_scope: delegatedScope(),
    authorization: {
      shell: true,
      network: false,
      browser_login: false,
      credentials: false,
      git_commit: false,
      git_push: false,
      publish: false,
      deploy_production: false,
      destructive_operations: false
    }
  };
}

test('bounded state packet excludes trace noise, secrets, and oversized inline evidence', () => {
  const packet = buildBoundedStatePacket({
    workflow: { run_id: 'W-1', objective: 'Finish task', state: 'VERIFYING' },
    task: task(),
    attempt: { attempt_id: 'A-2', number: 2, status: 'PARTIAL' },
    session: { session_id: 'S-1', executor_id: 'codex', status: 'READY' },
    latestResult: {
      status: 'PARTIAL',
      summary: 'x'.repeat(4_000),
      api_key: 'sk-test-abcdefghijklmnopqrstuvwxyz',
      artifacts: ['artifact://E-large']
    },
    acceptance: { passed: 4, failed: 1 },
    attention: [],
    events: [
      ...Array.from({ length: 40 }, (_, index) => ({
        event_id: `P-${index}`,
        type: 'executor.progress',
        lane: 'trace',
        timestamp: `2026-08-25T00:00:${String(index).padStart(2, '0')}Z`,
        payload: { stdout: 'noise'.repeat(100) }
      })),
      {
        event_id: 'E-done',
        type: 'executor.completed',
        lane: 'control',
        timestamp: '2026-08-25T00:01:00Z',
        payload: { artifact_ref: 'artifact://E-large' }
      }
    ]
  }, { maxBytes: 1_600, maxEvents: 12 });

  const serialized = JSON.stringify(packet);
  assert.ok(Buffer.byteLength(serialized) <= 1_600);
  assert.doesNotMatch(serialized, /sk-test-/);
  assert.equal(packet.recent_events.length, 1);
  assert.equal(packet.recent_events[0].type, 'executor.completed');
  assert.deepEqual(packet.artifact_refs, ['artifact://E-large']);
  assert.match(packet.handoff, /PARTIAL/);
});

test('typed decision validation rejects scope expansion and unknown decisions', () => {
  assert.match(
    validateDecision({ decision: 'TELEPORT', reason: 'faster' }, { task: task() }).join('\n'),
    /unknown decision/
  );
  assert.match(
    validateDecision({
      decision: 'FOLLOW_UP',
      reason: 'continue',
      delegated_scope: { ...delegatedScope(), allowed_changes: ['src/**'] }
    }, { task: task() }).join('\n'),
    /outside task allowed_changes/
  );
});

test('daemon auto-continues PARTIAL in the same session and completes after PASS', async (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  const executor = new FakeExecutor({
    capabilities: ['local.shell', 'local.test'],
    scenarios: [
      {
        events: [
          { id: 's1', type: 'thread.started', thread_id: 'S-1' },
          { id: 'a1-start', type: 'turn.started' },
          { id: 'a1-progress', type: 'item.completed', payload: { stdout: 'one failure' } },
          { id: 'a1-done', type: 'turn.completed' }
        ],
        result: { status: 'PARTIAL', summary: 'One Windows test remains', session_id: 'S-1' }
      },
      {
        events: [
          { id: 's2', type: 'thread.started', thread_id: 'S-1' },
          { id: 'a2-start', type: 'turn.started' },
          { id: 'a2-progress', type: 'item.completed', payload: { stdout: 'all green' } },
          { id: 'a2-done', type: 'turn.completed' }
        ],
        result: { status: 'PASS', summary: 'All tests pass', session_id: 'S-1' }
      }
    ]
  });
  const registry = new ExecutorRegistry();
  registry.register(executor, { priority: 10 });
  const decisions = new ScriptedDecisionRunner([
    {
      decision: 'FOLLOW_UP',
      reason: 'One acceptance criterion remains unmet',
      delegated_scope: delegatedScope('Run only the remaining Windows test')
    },
    { decision: 'COMPLETE', reason: 'Validated PASS satisfies acceptance' }
  ]);
  const daemon = new WorkflowDaemon({
    store,
    registry,
    decisionRunner: decisions,
    primaryCapabilities: ['reasoning'],
    validateResult: async (result) => ({
      valid: ['PASS', 'PARTIAL'].includes(result.status),
      acceptance_met: result.status === 'PASS'
    }),
    maxAttempts: 3
  });

  const outcome = await daemon.run(task(), { workspace_id: 'WS-1', cwd: process.cwd() });

  assert.equal(outcome.state, 'COMPLETED');
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.human_actions, 0);
  assert.deepEqual(executor.stats(), { starts: 1, resumes: 1, cancels: 0 });
  assert.equal(decisions.calls.length, 2, 'progress events must not trigger decision turns');
  assert.equal(store.listAttempts({ workflowRunId: outcome.workflow_run_id }).length, 2);
  assert.equal(store.getSession('S-1').generation, 2);
  assert.equal(store.getWorkflow(outcome.workflow_run_id).state, 'COMPLETED');
  assert.equal(
    store.listEvents({ workflowRunId: outcome.workflow_run_id, controlOnly: true })
      .filter((event) => event.type === 'executor.completed').length,
    2
  );
});

test('daemon never starts an executor when the primary has no capability gap', async (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  const executor = new FakeExecutor({ capabilities: ['local.shell', 'local.test'] });
  const registry = new ExecutorRegistry();
  registry.register(executor);
  const daemon = new WorkflowDaemon({
    store,
    registry,
    decisionRunner: new ScriptedDecisionRunner([]),
    primaryCapabilities: ['reasoning', 'local.shell', 'local.test']
  });

  const outcome = await daemon.run(task(), {
    onPrimary: async () => ({ status: 'PASS', summary: 'Completed directly' })
  });

  assert.equal(outcome.owner, 'primary');
  assert.equal(outcome.state, 'COMPLETED');
  assert.deepEqual(executor.stats(), { starts: 0, resumes: 0, cancels: 0 });
});

test('executor lifecycle failure durably closes the attempt and workflow', async (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  const broken = {
    id: 'broken',
    async detect() { return { ready: true, reason: null }; },
    async capabilities() { return ['local.shell', 'local.test']; },
    async start() { throw new Error('spawn denied'); }
  };
  const registry = new ExecutorRegistry();
  registry.register(broken);
  const daemon = new WorkflowDaemon({
    store,
    registry,
    decisionRunner: new ScriptedDecisionRunner([]),
    primaryCapabilities: ['reasoning']
  });

  const outcome = await daemon.run(task());
  const [attempt] = store.listAttempts({ workflowRunId: outcome.workflow_run_id });
  assert.equal(outcome.state, 'FAILED');
  assert.equal(attempt.status, 'FAIL');
  assert.match(attempt.evidence.summary, /spawn denied/);
  assert.equal(store.getWorkflow(outcome.workflow_run_id).state, 'FAILED');
  assert.match(store.listAttention({ openOnly: true })[0].message, /spawn denied/);
});

test('daemon registers an executor PID after the session is announced', async (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  const registrations = [];
  const executor = new FakeExecutor({
    capabilities: ['local.shell', 'local.test'],
    events: [
      { id: 'session', type: 'thread.started', thread_id: 'S-pid' },
      { id: 'done', type: 'turn.completed' }
    ],
    result: { status: 'FAIL', summary: 'done', session_id: 'S-pid' }
  });
  const originalStart = executor.start.bind(executor);
  executor.start = async (...args) => ({ ...await originalStart(...args), pid: 4242 });
  const registry = new ExecutorRegistry();
  registry.register(executor);
  const daemon = new WorkflowDaemon({
    store,
    registry,
    decisionRunner: new ScriptedDecisionRunner([{ decision: 'FAIL', reason: 'expected' }]),
    primaryCapabilities: ['reasoning'],
    processSupervisor: {
      register(binding) { registrations.push(binding); },
      unregister() {}
    }
  });

  await daemon.run(task());
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].pid, 4242);
  assert.equal(registrations[0].session.session_id, 'S-pid');
});
