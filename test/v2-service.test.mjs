import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeService } from '../lib/runtime/service.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

test('durable jobs are idempotent, claimable, and recoverable after a worker crash', (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  const job = {
    job_id: 'J-1', workflow_run_id: 'W-1', type: 'human.replied',
    payload: { attention_id: 'ATT-1', response: 'continue' }
  };
  assert.equal(store.enqueueJob(job), true);
  assert.equal(store.enqueueJob(job), false);
  assert.equal(store.claimJob('J-1', 'worker-a').status, 'RUNNING');
  assert.equal(store.requeueRunningJobs('worker-a'), 1);
  assert.equal(store.listJobs({ status: 'PENDING' })[0].job_id, 'J-1');
  store.completeJob('J-1', { accepted: true });
  assert.equal(store.getJob('J-1').status, 'COMPLETED');
});

test('attention response resolves the durable row and creates one wakeup job', (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  store.saveWorkflow({ run_id: 'W-human', objective: 'Need input', state: 'WAITING_FOR_HUMAN' });
  store.createAttention({
    attention_id: 'ATT-human', workflow_run_id: 'W-human', type: 'DECISION', message: 'Choose'
  });

  const resolved = store.respondToAttention({
    attentionId: 'ATT-human', response: 'Use option A', responseType: 'human.replied'
  });
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.response, 'Use option A');
  assert.equal(store.listAttention({ openOnly: true }).length, 0);
  assert.equal(store.listJobs({ status: 'PENDING' }).length, 1);
  assert.equal(store.respondToAttention({
    attentionId: 'ATT-human', response: 'duplicate', responseType: 'human.replied'
  }).status, 'RESOLVED');
  assert.equal(store.listJobs({ status: 'PENDING' }).length, 1);
});

test('daemon lease is exclusive, expires, and can be renewed by its owner', (t) => {
  let now = Date.parse('2026-08-25T00:00:00Z');
  const store = new SQLiteRuntimeStore(':memory:', { now: () => new Date(now).toISOString() });
  t.after(() => store.close());
  assert.equal(store.acquireLease({ name: 'relay', owner_id: 'one', pid: 101, ttl_ms: 1_000 }), true);
  assert.equal(store.acquireLease({ name: 'relay', owner_id: 'two', pid: 202, ttl_ms: 1_000 }), false);
  now += 500;
  assert.equal(store.renewLease({ name: 'relay', owner_id: 'one', ttl_ms: 1_000 }), true);
  now += 1_500;
  assert.equal(store.acquireLease({ name: 'relay', owner_id: 'two', pid: 202, ttl_ms: 1_000 }), true);
});

test('runtime service recovers jobs and drains workflows in a single ordered cycle', async (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  store.saveWorkflow({ run_id: 'W-cycle', objective: 'Recover', state: 'RUNNING' });
  store.enqueueJob({ job_id: 'J-cycle', workflow_run_id: 'W-cycle', type: 'workflow.resume', payload: {} });
  const calls = [];
  const service = new RuntimeService({
    store,
    ownerId: 'service-one',
    processSupervisor: { async reconcile() { calls.push('reconcile'); return { alive: [], lost: [] }; } },
    pipeline: { async drainPending({ workflowRunId }) { calls.push(`drain:${workflowRunId}`); return { routed: 0, failed: 0 }; } },
    onJob: async (job) => { calls.push(`job:${job.job_id}`); return { resumed: true }; }
  });
  const report = await service.runOnce();
  assert.deepEqual(calls, ['reconcile', 'drain:W-cycle', 'job:J-cycle']);
  assert.equal(report.jobs_completed, 1);
  assert.equal(store.getJob('J-cycle').status, 'COMPLETED');
  service.close();
});
