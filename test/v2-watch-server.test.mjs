import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeWatchServer } from '../lib/runtime/watch-server.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

async function waitFor(predicate, { timeoutMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

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

test('watch server exposes a workflow aggregate and cursor-aware event queries through an injected store', async (t) => {
  const calls = [];
  const events = [
    { event_id: 'E-1', cursor: 1, workflow_run_id: 'W-aggregate', type: 'task.started' },
    { event_id: 'E-2', cursor: 2, workflow_run_id: 'W-aggregate', type: 'task.completed' }
  ];
  const store = {
    listWorkflows: () => [{ run_id: 'W-aggregate', state: 'COMPLETED' }],
    getWorkflow: (runId) => ({ run_id: runId, state: 'COMPLETED' }),
    listAttempts: ({ workflowRunId }) => [{ attempt_id: 'A-1', workflow_run_id: workflowRunId }],
    listAttention: () => [{ attention_id: 'ATT-1', workflow_run_id: 'W-aggregate', status: 'OPEN' }],
    listEventsAfter: (query) => {
      calls.push(query);
      return events.filter((event) => event.cursor > Number(query.afterCursor ?? 0));
    }
  };
  const server = new RuntimeWatchServer(store, { port: 0 });
  t.after(() => server.close());
  const address = await server.listen();
  const base = `http://${address.address}:${address.port}`;

  const aggregate = await (await fetch(`${base}/workflows/W-aggregate`)).json();
  assert.equal(aggregate.workflow.run_id, 'W-aggregate');
  assert.equal(aggregate.attempts[0].attempt_id, 'A-1');
  assert.equal(aggregate.attention[0].attention_id, 'ATT-1');
  assert.equal(aggregate.events.length, 2);

  const page = await (await fetch(`${base}/workflows/W-aggregate/events?after=1`)).json();
  assert.deepEqual(page.events.map((event) => event.event_id), ['E-2']);
  assert.equal(page.next_cursor, '2');
  assert.ok(calls.some((call) => call.workflowRunId === 'W-aggregate' && call.afterCursor === '1'));
});

test('SSE resumes from Last-Event-ID, heartbeats, enforces client limits, and cleans up disconnects', async (t) => {
  const events = [
    { event_id: 'E-2', cursor: 2, workflow_run_id: 'W-stream', type: 'task.progress' }
  ];
  const store = {
    listWorkflows: () => [],
    listEventsAfter: ({ afterCursor }) => events.filter((event) => event.cursor > Number(afterCursor ?? 0))
  };
  const server = new RuntimeWatchServer(store, {
    port: 0,
    heartbeatMs: 20,
    pollMs: 10,
    maxClients: 1
  });
  t.after(() => server.close());
  const address = await server.listen();
  const base = `http://${address.address}:${address.port}`;
  const controller = new AbortController();
  const response = await fetch(`${base}/events/stream?workflow_run_id=W-stream`, {
    headers: { 'last-event-id': '1' },
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  assert.equal((await fetch(`${base}/events/stream?workflow_run_id=W-stream`)).status, 503);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = '';
  await waitFor(async () => false).catch(() => {});
  while (!received.includes(': heartbeat')) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value, { stream: true });
  }
  assert.match(received, /id: 2/);
  assert.match(received, /event: task\.progress/);
  assert.match(received, /: heartbeat/);
  controller.abort();
  await waitFor(() => server.clientCount === 0);
});

test('watch server refuses non-loopback binding without explicit authorization', () => {
  const store = { listWorkflows: () => [] };
  assert.throws(() => new RuntimeWatchServer(store, { host: '0.0.0.0' }), /explicit|remote|loopback/i);
  assert.doesNotThrow(() => new RuntimeWatchServer(store, { host: '0.0.0.0', allowRemote: true }));
});
