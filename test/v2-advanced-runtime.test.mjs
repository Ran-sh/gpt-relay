import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkflowGraph } from '../lib/runtime/workflow-graph.mjs';
import { RemoteRunnerQueue } from '../lib/runtime/remote-runner.mjs';
import { ScheduleEngine } from '../lib/runtime/scheduler-service.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

test('workflow graph releases a barrier only after every dependency passes', (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  const graph = new WorkflowGraph(store);
  graph.create('W-graph', [
    { node_id: 'A', task: { objective: 'A' } },
    { node_id: 'B', task: { objective: 'B' } },
    { node_id: 'C', task: { objective: 'join' }, depends_on: ['A', 'B'] }
  ]);
  assert.deepEqual(graph.ready('W-graph').map((node) => node.node_id), ['A', 'B']);
  graph.complete('W-graph', 'A', { status: 'PASS' });
  assert.deepEqual(graph.ready('W-graph').map((node) => node.node_id), ['B']);
  graph.complete('W-graph', 'B', { status: 'PASS' });
  assert.deepEqual(graph.ready('W-graph').map((node) => node.node_id), ['C']);
  assert.throws(() => graph.create('W-cycle', [
    { node_id: 'X', task: {}, depends_on: ['Y'] },
    { node_id: 'Y', task: {}, depends_on: ['X'] }
  ]), /cycle/i);
});

test('remote runner queue fences stale generations and duplicate results', (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  const queue = new RemoteRunnerQueue(store, { idFactory: () => 'token-1' });
  queue.dispatch({ runner_job_id: 'RJ-1', workflow_run_id: 'W-runner', task: { id: 'T-1' }, generation: 2 });
  const lease = queue.claim('runner-a', { ttlMs: 1_000 });
  assert.equal(lease.runner_job_id, 'RJ-1');
  assert.equal(queue.heartbeat('RJ-1', 'runner-a', { ttlMs: 1_000 }), true);
  assert.throws(() => queue.submit({
    runner_job_id: 'RJ-1', runner_id: 'runner-a', token: 'token-1', generation: 1,
    result: { status: 'PASS' }
  }), /generation/i);
  assert.equal(queue.submit({
    runner_job_id: 'RJ-1', runner_id: 'runner-a', token: 'token-1', generation: 2,
    result: { status: 'PASS' }
  }).status, 'COMPLETED');
  assert.throws(() => queue.submit({
    runner_job_id: 'RJ-1', runner_id: 'runner-a', token: 'token-1', generation: 2,
    result: { status: 'PASS' }
  }), /already completed/i);
});

test('expired remote runner lease is recovered with a new token and generation', (t) => {
  let now = Date.parse('2026-08-25T00:00:00Z');
  let token = 0;
  const store = new SQLiteRuntimeStore(':memory:', { now: () => new Date(now).toISOString() });
  t.after(() => store.close());
  const queue = new RemoteRunnerQueue(store, {
    now: () => new Date(now),
    idFactory: () => `token-${++token}`
  });
  queue.dispatch({ runner_job_id: 'RJ-expired', workflow_run_id: 'W-runner', task: {}, generation: 1 });
  const stale = queue.claim('runner-a', { ttlMs: 100 });
  now += 101;
  assert.equal(queue.heartbeat('RJ-expired', 'runner-a', { ttlMs: 100 }), false);
  assert.throws(() => queue.submit({
    runner_job_id: 'RJ-expired', runner_id: 'runner-a', token: stale.token,
    generation: stale.generation, result: { status: 'PASS' }
  }), /expired/i);
  const recovered = queue.claim('runner-b', { ttlMs: 100 });
  assert.equal(recovered.generation, 2);
  assert.notEqual(recovered.token, stale.token);
  assert.throws(() => queue.submit({
    runner_job_id: 'RJ-expired', runner_id: 'runner-a', token: stale.token,
    generation: stale.generation, result: { status: 'PASS' }
  }), /lease|token/i);
});

test('schedule engine emits each due occurrence once', (t) => {
  let now = Date.parse('2026-08-25T00:00:00Z');
  const store = new SQLiteRuntimeStore(':memory:', { now: () => new Date(now).toISOString() });
  t.after(() => store.close());
  const engine = new ScheduleEngine(store, { now: () => new Date(now) });
  engine.upsert({ schedule_id: 'S-1', every_ms: 1_000, task: { id: 'T-scheduled' } });
  assert.equal(engine.tick().length, 0);
  now += 1_000;
  assert.equal(engine.tick()[0].occurrence_id, 'S-1@2026-08-25T00:00:01.000Z');
  assert.equal(engine.tick().length, 0);
});
