import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_PRIMARY_CAPABILITIES,
  createProductionRoute,
  createRuntimeJobHandler
} from '../lib/runtime/production-runtime.mjs';
import { computeCapabilityGap } from '../lib/workflow/capability-gap.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

test('production job handler executes observed task contracts and durable resumptions', async (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'gpt-relay-production-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const file = path.join(temporary, 'docs', 'agent-tasks', 'task.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ id: 'T-runtime' }));
  const calls = [];
  const daemon = {
    async run(task, context) { calls.push(['run', task, context]); return { state: 'COMPLETED' }; },
    async resume(runId, input, context) { calls.push(['resume', runId, input, context]); return { state: 'RUNNING' }; }
  };
  const handler = createRuntimeJobHandler({ daemon, cwd: temporary });

  assert.equal((await handler({
    type: 'task.created', workflow_run_id: 'W-observed',
    payload: { path: file, workspace_root: temporary }
  })).state, 'COMPLETED');
  assert.equal((await handler({
    type: 'human.replied', workflow_run_id: 'W-runtime', payload: { response: 'continue' }
  })).state, 'RUNNING');
  assert.equal(calls[0][0], 'run');
  assert.equal(calls[0][2].workflow_run_id, 'W-observed');
  assert.equal(calls[0][2].cwd, temporary);
  assert.equal(calls[1][2].type, 'human.replied');
});

test('production job handler persists approval denial without invoking an executor', async (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  store.saveWorkflow({ run_id: 'W-denied', objective: 'Publish', state: 'WAITING_FOR_APPROVAL' });
  const handler = createRuntimeJobHandler({
    store,
    daemon: { run() { throw new Error('unexpected'); }, resume() { throw new Error('unexpected'); } }
  });
  const result = await handler({
    type: 'approval.denied', workflow_run_id: 'W-denied', payload: { response: 'not authorized' }
  });
  assert.equal(result.state, 'FAILED');
  assert.equal(store.getWorkflow('W-denied').reason, 'not authorized');
  await assert.rejects(() => handler({ type: 'unknown', workflow_run_id: 'W-denied', payload: {} }), /unsupported/i);
});

test('production primary owns reasoning so the example delegates only executable capabilities', () => {
  const required = ['reasoning', 'local.shell', 'local.test'];
  assert.deepEqual(computeCapabilityGap(required, DEFAULT_PRIMARY_CAPABILITIES), ['local.shell', 'local.test']);
});

test('production control route idempotently converts observed tasks into durable jobs', async (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  const route = createProductionRoute(store, { workspaceRoot: 'C:/repo' });
  const event = {
    event_id: 'E-route', workflow_run_id: 'W-route', type: 'task.created',
    payload: { path: 'C:/repo/docs/task.json' }
  };
  await route(event);
  await route(event);
  const jobs = store.listJobs({ status: 'PENDING' });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload.workspace_root, path.resolve('C:/repo'));
});

test('reclaimed task job never repeats a completed workflow or uncertain side effects', async (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'gpt-relay-recovery-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const file = path.join(temporary, 'task.json');
  writeFileSync(file, JSON.stringify({ id: 'T-recovery' }));
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  let runs = 0;
  const handler = createRuntimeJobHandler({
    store,
    cwd: temporary,
    daemon: {
      async run() { runs += 1; return { state: 'COMPLETED' }; },
      async resume() { throw new Error('unexpected resume'); }
    }
  });
  const job = {
    job_id: 'J-recovered', type: 'task.created', attempts: 2,
    workflow_run_id: 'W-recovered', payload: { path: file, workspace_root: temporary }
  };

  store.saveWorkflow({
    run_id: 'W-recovered', task_id: 'T-recovery', objective: 'done', state: 'COMPLETED',
    checkpoint: { attempt_count: 1 }
  });
  assert.equal((await handler(job)).state, 'COMPLETED');
  assert.equal(runs, 0);

  store.saveWorkflow({
    run_id: 'W-recovered', task_id: 'T-recovery', objective: 'uncertain', state: 'RUNNING',
    checkpoint: { attempt_count: 1 }
  });
  assert.equal((await handler(job)).state, 'PAUSED');
  assert.equal(runs, 0);
  assert.equal(store.listAttention({ openOnly: true })[0].type, 'RECOVERY');
});
