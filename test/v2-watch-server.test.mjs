import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeWatchServer } from '../lib/runtime/watch-server.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

test('watch server exposes read-only health, workflows, and events', async (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  const server = new RuntimeWatchServer(store, { host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await server.close();
    store.close();
  });
  store.saveWorkflow({ run_id: 'W-watch', objective: 'observe safely', state: 'RUNNING' });
  store.appendEvent({
    event_id: 'E-watch', workflow_run_id: 'W-watch', source: 'runtime', type: 'task.started',
    timestamp: new Date().toISOString(), payload: {}, idempotency_key: 'watch:1', lane: 'telemetry'
  });
  const address = await server.listen();
  const base = `http://${address.address}:${address.port}`;

  assert.equal((await (await fetch(`${base}/health`)).json()).ok, true);
  assert.equal((await (await fetch(`${base}/workflows`)).json()).workflows[0].run_id, 'W-watch');
  assert.equal((await (await fetch(`${base}/workflows/W-watch/events`)).json()).events[0].event_id, 'E-watch');
  assert.equal((await fetch(`${base}/workflows`, { method: 'POST' })).status, 405);
});

test('watch server bounds event result size and rejects unknown routes', async (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  const server = new RuntimeWatchServer(store, { host: '127.0.0.1', port: 0, maxEvents: 2 });
  t.after(async () => {
    await server.close();
    store.close();
  });
  for (let index = 0; index < 3; index += 1) {
    store.appendEvent({
      event_id: `E-${index}`, workflow_run_id: 'W-bound', source: 'runtime', type: 'task.progress',
      timestamp: new Date().toISOString(), payload: {}, idempotency_key: `bound:${index}`, lane: 'telemetry'
    });
  }
  const address = await server.listen();
  const base = `http://${address.address}:${address.port}`;
  const response = await fetch(`${base}/workflows/W-bound/events?limit=999`);
  assert.equal((await response.json()).events.length, 2);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
});
