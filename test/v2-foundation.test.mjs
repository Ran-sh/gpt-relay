import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertAuthorized,
  validateTaskVNext
} from '../lib/contracts/v2.mjs';
import { FakeExecutor } from '../lib/executors/fake.mjs';
import { computeCapabilityGap } from '../lib/workflow/capability-gap.mjs';
import { WorkflowScheduler } from '../lib/workflow/scheduler.mjs';
import { transitionWorkflow } from '../lib/workflow/state-machine.mjs';

function task(overrides = {}) {
  return {
    id: 'T-104',
    objective: 'Validate the Windows installer',
    required_capabilities: ['local.shell', 'local.test', 'windows'],
    allowed_changes: ['docs/agent-results/T-104.json'],
    forbidden_changes: ['src/**'],
    delegated_scope: {
      objective: 'Run the Windows installer tests and return evidence',
      required_capabilities: ['local.shell', 'local.test', 'windows'],
      allowed_changes: ['docs/agent-results/T-104.json'],
      forbidden_changes: ['src/**'],
      return: ['exit_status', 'test_output', 'artifacts']
    },
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
    },
    ...overrides
  };
}

test('capability gap is stable, unique, and independent from authorization', () => {
  assert.deepEqual(
    computeCapabilityGap(
      ['reasoning', 'local.test', 'windows', 'local.test'],
      ['reasoning', 'github.read']
    ),
    ['local.test', 'windows']
  );

  assert.throws(
    () => assertAuthorized(task(), ['git.push']),
    /authorization denies git_push/
  );
});

test('vNext task validation rejects delegated scope expansion', () => {
  assert.deepEqual(validateTaskVNext(task()), []);

  const expandedCapability = task({
    delegated_scope: {
      ...task().delegated_scope,
      required_capabilities: ['local.shell', 'local.test', 'windows', 'credentials']
    }
  });
  assert.match(validateTaskVNext(expandedCapability).join('\n'), /credentials.*outside task required_capabilities/);

  const expandedPath = task({
    delegated_scope: {
      ...task().delegated_scope,
      allowed_changes: ['src/**']
    }
  });
  assert.match(validateTaskVNext(expandedPath).join('\n'), /src\/\*\*.*outside task allowed_changes/);
});

test('workflow state requires validated evidence before completion', () => {
  let state = 'RUNNING';
  state = transitionWorkflow(state, { type: 'task.delegated', payload: { executor_ready: true } });
  assert.equal(state, 'WAITING_FOR_EXECUTOR');

  state = transitionWorkflow(state, { type: 'executor.started', payload: {} });
  assert.equal(state, 'RUNNING');

  state = transitionWorkflow(state, { type: 'executor.completed', payload: {} });
  assert.equal(state, 'VERIFYING');

  state = transitionWorkflow(state, {
    type: 'result.validated',
    payload: { result_status: 'PARTIAL', acceptance_met: false }
  });
  assert.equal(state, 'RUNNING');

  state = transitionWorkflow(state, { type: 'executor.completed', payload: {} });
  state = transitionWorkflow(state, {
    type: 'result.validated',
    payload: { result_status: 'PASS', acceptance_met: true }
  });
  assert.equal(state, 'COMPLETED');

  assert.equal(
    transitionWorkflow('COMPLETED', { type: 'executor.failed', payload: {} }),
    'COMPLETED'
  );
});

test('scheduler wakes only on control-plane events and consumes each event once', () => {
  const scheduler = new WorkflowScheduler();
  const progress = { event_id: 'E-1', type: 'executor.progress', payload: {} };
  const completed = { event_id: 'E-2', type: 'executor.completed', payload: {} };

  assert.equal(scheduler.propose(progress), null);
  assert.deepEqual(scheduler.propose(completed), {
    trigger: 'executor_completed',
    event_id: 'E-2'
  });
  assert.equal(scheduler.propose(completed), null);
});

test('FakeExecutor provides deterministic readiness, event, and result evidence', async () => {
  const executor = new FakeExecutor({
    capabilities: ['local.shell', 'local.test', 'windows'],
    events: [
      { type: 'executor.started', payload: {} },
      { type: 'executor.completed', payload: { exit_status: 1 } }
    ],
    result: { status: 'PARTIAL', summary: 'One test failed' }
  });

  assert.deepEqual(await executor.detect(), { ready: true, reason: null });
  assert.deepEqual(await executor.capabilities(), ['local.shell', 'local.test', 'windows']);

  const handle = await executor.start(task(), { attempt_id: 'A-1' });
  const events = [];
  for await (const event of executor.events(handle)) events.push(event.type);

  assert.deepEqual(events, ['executor.started', 'executor.completed']);
  assert.deepEqual(await executor.collectResult(handle), {
    status: 'PARTIAL',
    summary: 'One test failed'
  });
});
