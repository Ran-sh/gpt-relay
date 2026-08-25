import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeExecutor } from '../lib/executors/fake.mjs';
import { ExecutorRegistry } from '../lib/executors/registry.mjs';
import { ScriptedDecisionRunner } from '../lib/orchestrator/decision-runner.mjs';
import { WorkflowDaemon } from '../lib/runtime/daemon.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

function permissionTask() {
  return {
    id: 'T-permission', objective: 'Publish verified package',
    required_capabilities: ['reasoning', 'local.shell', 'publish'],
    allowed_changes: ['docs/agent-results/T-permission.json'], forbidden_changes: ['src/**'],
    delegated_scope: {
      objective: 'Prepare and request publish permission',
      required_capabilities: ['local.shell', 'publish'],
      allowed_changes: ['docs/agent-results/T-permission.json'], forbidden_changes: ['src/**'],
      return: ['status', 'evidence']
    },
    authorization: {
      shell: true, network: false, browser_login: false, credentials: false,
      git_commit: false, git_push: false, publish: false, deploy_production: false,
      destructive_operations: false
    }
  };
}

test('executor permission request becomes one durable Attention and cancels the handle', async (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  const executor = new FakeExecutor({
    capabilities: ['local.shell', 'publish'],
    events: [
      { id: 'permission-1', type: 'request.opened', payload: {
        operation: 'npm.publish', capability: 'publish', token: 'secret-value'
      } },
      { id: 'should-not-run', type: 'turn.completed' }
    ],
    result: { status: 'PASS', summary: 'must not be collected' }
  });
  const registry = new ExecutorRegistry();
  registry.register(executor);
  const daemon = new WorkflowDaemon({
    store, registry, decisionRunner: new ScriptedDecisionRunner([]),
    primaryCapabilities: ['reasoning']
  });

  const outcome = await daemon.run(permissionTask());
  const attention = store.listAttention({ openOnly: true })[0];
  assert.equal(outcome.state, 'WAITING_FOR_APPROVAL');
  assert.equal(attention.type, 'APPROVAL');
  assert.equal(attention.operation, 'npm.publish');
  assert.equal(attention.required_authorization, 'publish');
  assert.doesNotMatch(JSON.stringify(attention), /secret-value/);
  assert.deepEqual(executor.stats(), { starts: 1, resumes: 0, cancels: 1 });
  assert.equal(store.listAttempts({ workflowRunId: outcome.workflow_run_id })[0].status, 'BLOCKED');
  assert.equal(store.listEvents({ workflowRunId: outcome.workflow_run_id })[0].type, 'permission.requested');
});

test('unknown permission requests fail closed as SECURITY Attention', async (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  const executor = new FakeExecutor({
    capabilities: ['local.shell', 'publish'],
    events: [{ id: 'permission-unknown', type: 'request.opened', payload: { operation: 'device.root' } }]
  });
  const registry = new ExecutorRegistry();
  registry.register(executor);
  const daemon = new WorkflowDaemon({
    store, registry, decisionRunner: new ScriptedDecisionRunner([]), primaryCapabilities: ['reasoning']
  });
  const outcome = await daemon.run(permissionTask());
  assert.equal(outcome.state, 'WAITING_FOR_HUMAN');
  assert.equal(store.listAttention({ openOnly: true })[0].type, 'SECURITY');
});
