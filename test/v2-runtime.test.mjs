import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeExecutorEvent, redactSecrets } from '../lib/relay/events.mjs';
import { RelayPipeline } from '../lib/relay/pipeline.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

function withStore(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'gpt-relay-runtime-'));
  const database = path.join(root, 'runtime.sqlite');
  const store = new SQLiteRuntimeStore(database);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, database };
}

test('SQLite runtime state survives a close and reopen', (t) => {
  const { store, database } = withStore(t);
  store.saveWorkflow({ run_id: 'W-1', objective: 'Ship relay', state: 'RUNNING' });
  store.saveAttempt({
    attempt_id: 'A-1',
    task_id: 'T-1',
    workflow_run_id: 'W-1',
    number: 1,
    status: 'PARTIAL',
    evidence: { failed: 1 }
  });
  store.saveSession({
    session_id: 'S-1',
    executor_id: 'codex',
    workspace_id: 'WS-1',
    task_id: 'T-1',
    conversation_root_id: 'C-1',
    head_attempt_id: 'A-1',
    status: 'READY',
    generation: 3
  });
  store.setCursor('codex:S-1', 'cursor-42');
  store.createAttention({
    attention_id: 'ATT-1',
    workflow_run_id: 'W-1',
    type: 'APPROVAL',
    message: 'git push requested'
  });
  store.close();

  const reopened = new SQLiteRuntimeStore(database);
  t.after(() => reopened.close());
  assert.equal(reopened.getWorkflow('W-1').state, 'RUNNING');
  assert.deepEqual(reopened.getAttempt('A-1').evidence, { failed: 1 });
  assert.equal(reopened.getSession('S-1').generation, 3);
  assert.equal(reopened.getCursor('codex:S-1'), 'cursor-42');
  assert.equal(reopened.listAttention({ openOnly: true })[0].attention_id, 'ATT-1');
  reopened.close();
});

test('normalizer maps provider events to canonical control and trace lanes', () => {
  const context = {
    workflow_run_id: 'W-1',
    task_id: 'T-1',
    attempt_id: 'A-1',
    source: 'codex',
    session_id: 'S-1',
    generation: 4
  };

  const progress = normalizeExecutorEvent({
    id: 'native-1',
    type: 'item.completed',
    payload: { item: { type: 'command_execution', output: 'ok' } }
  }, context);
  assert.equal(progress.type, 'executor.progress');
  assert.equal(progress.lane, 'trace');
  assert.equal(progress.generation, 4);

  const approval = normalizeExecutorEvent({
    id: 'native-2',
    type: 'request.opened',
    payload: { requestType: 'permission', summary: 'run tests' }
  }, context);
  assert.equal(approval.type, 'approval.requested');
  assert.equal(approval.lane, 'control');

  const completed = normalizeExecutorEvent({
    id: 'native-3',
    type: 'turn.completed',
    payload: { status: 'completed' }
  }, context);
  assert.equal(completed.type, 'executor.completed');
  assert.equal(completed.lane, 'control');
  assert.match(completed.idempotency_key, /codex:S-1:native-3/);
});

test('id-less executor events remain distinct across attempts and generations', async (t) => {
  const { store } = withStore(t);
  const pipeline = new RelayPipeline({ store });
  const raw = { type: 'turn.started', payload: { phase: 'execute' } };
  const base = { workflow_run_id: 'W-generation', task_id: 'T-1', source: 'codex', session_id: 'S-1' };

  assert.equal((await pipeline.accept(raw, { ...base, attempt_id: 'A-1', generation: 1 })).status, 'routed');
  assert.equal((await pipeline.accept(raw, { ...base, attempt_id: 'A-2', generation: 2 })).status, 'routed');
  assert.equal(store.listEvents({ workflowRunId: 'W-generation' }).length, 2);
});

test('provider-native IDs are scoped to their workflow and attempt', async (t) => {
  const { store } = withStore(t);
  const pipeline = new RelayPipeline({ store });
  const raw = { id: 'provider-local-1', type: 'turn.completed', payload: { status: 'completed' } };
  const context = { task_id: 'T-1', attempt_id: 'A-1', source: 'provider', generation: 1 };

  assert.equal((await pipeline.accept(raw, { ...context, workflow_run_id: 'W-native-1' })).status, 'routed');
  assert.equal((await pipeline.accept(raw, { ...context, workflow_run_id: 'W-native-2' })).status, 'routed');
  assert.equal(store.listEvents({ workflowRunId: 'W-native-1' }).length, 1);
  assert.equal(store.listEvents({ workflowRunId: 'W-native-2' }).length, 1);
});

test('failed control routing remains pending and is drained after restart', async (t) => {
  const { store } = withStore(t);
  let calls = 0;
  const pipeline = new RelayPipeline({
    store,
    route: async () => {
      calls += 1;
      if (calls === 1) throw new Error('router unavailable');
    }
  });
  const raw = { id: 'native-route', type: 'turn.completed', payload: { status: 'completed' } };
  const context = { workflow_run_id: 'W-route', attempt_id: 'A-1', source: 'codex', session_id: 'S-1', generation: 1 };

  await assert.rejects(pipeline.accept(raw, context), /router unavailable/);
  assert.equal(store.listPendingControlEvents({ workflowRunId: 'W-route' }).length, 1);
  const restarted = new RelayPipeline({ store, route: async () => { calls += 1; } });
  assert.deepEqual(await restarted.drainPending({ workflowRunId: 'W-route' }), {
    routed: 1,
    failed: 0
  });
  assert.equal(calls, 2);
  assert.equal(store.listPendingControlEvents({ workflowRunId: 'W-route' }).length, 0);
  assert.equal((await restarted.accept(raw, context)).status, 'duplicate');
});

test('redaction preserves boolean authorization policy while hiding credentials', () => {
  assert.deepEqual(redactSecrets({
    authorization: { shell: true, credentials: false },
    api_key: 'sk-test-abcdefghijklmnopqrstuvwxyz'
  }), {
    authorization: { shell: true, credentials: false },
    api_key: '[REDACTED]'
  });
});

test('relay persists before routing, deduplicates, fences stale sessions, and keeps progress quiet', async (t) => {
  const { store } = withStore(t);
  store.saveSession({
    session_id: 'S-1',
    executor_id: 'codex',
    workspace_id: 'WS-1',
    task_id: 'T-1',
    conversation_root_id: 'C-1',
    head_attempt_id: 'A-1',
    status: 'RUNNING',
    generation: 2
  });

  const routed = [];
  const pipeline = new RelayPipeline({
    store,
    maxInlineBytes: 180,
    route: async (event) => {
      assert.ok(store.getEvent(event.event_id), 'event must be durable before routing');
      routed.push(event.type);
    }
  });
  const context = {
    workflow_run_id: 'W-1',
    task_id: 'T-1',
    attempt_id: 'A-1',
    source: 'codex',
    session_id: 'S-1',
    generation: 2
  };

  const secret = 'sk-test-abcdefghijklmnopqrstuvwxyz';
  const progress = await pipeline.accept({
    id: 'native-progress',
    type: 'item.completed',
    payload: { api_key: secret, stdout: 'x'.repeat(2_000) }
  }, context);
  assert.equal(progress.status, 'stored_trace');
  assert.equal(routed.length, 0);

  const storedProgress = store.getEvent(progress.event.event_id);
  assert.equal(storedProgress.payload.truncated, true);
  assert.match(storedProgress.payload.artifact_ref, /^artifact:\/\//);
  const artifact = store.getArtifact(storedProgress.payload.artifact_ref);
  assert.doesNotMatch(JSON.stringify(artifact.content), /sk-test-/);
  assert.match(JSON.stringify(artifact.content), /\[REDACTED\]/);

  const completedRaw = {
    id: 'native-completed',
    type: 'turn.completed',
    payload: { status: 'completed' }
  };
  assert.equal((await pipeline.accept(completedRaw, context)).status, 'routed');
  assert.equal((await pipeline.accept(completedRaw, context)).status, 'duplicate');
  assert.deepEqual(routed, ['executor.completed']);
  assert.equal(store.listEvents({ workflowRunId: 'W-1', controlOnly: true }).length, 1);

  const stale = await pipeline.accept({
    id: 'native-stale',
    type: 'turn.completed',
    payload: { status: 'completed' }
  }, { ...context, generation: 1 });
  assert.equal(stale.status, 'stale');
  assert.equal(store.listEvents({ workflowRunId: 'W-1' }).length, 2);
});
