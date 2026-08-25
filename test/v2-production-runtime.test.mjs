import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRuntimeJobHandler } from '../lib/runtime/production-runtime.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

test('production job handler executes observed task contracts and durable resumptions', async (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'gpt-relay-production-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const file = path.join(temporary, 'task.json');
  writeFileSync(file, JSON.stringify({ id: 'T-runtime' }));
  const calls = [];
  const daemon = {
    async run(task, context) { calls.push(['run', task, context]); return { state: 'COMPLETED' }; },
    async resume(runId, input, context) { calls.push(['resume', runId, input, context]); return { state: 'RUNNING' }; }
  };
  const handler = createRuntimeJobHandler({ daemon, cwd: temporary });

  assert.equal((await handler({
    type: 'task.created', workflow_run_id: 'W-observed', payload: { path: file }
  })).state, 'COMPLETED');
  assert.equal((await handler({
    type: 'human.replied', workflow_run_id: 'W-runtime', payload: { response: 'continue' }
  })).state, 'RUNNING');
  assert.equal(calls[0][0], 'run');
  assert.equal(calls[0][2].workflow_run_id, 'W-observed');
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
