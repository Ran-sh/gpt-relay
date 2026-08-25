import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileContractObserver } from '../lib/relay/observer.mjs';
import { RelayPipeline } from '../lib/relay/pipeline.mjs';
import { ProcessSupervisor } from '../lib/runtime/process-supervisor.mjs';
import { SessionRegistry } from '../lib/runtime/session-registry.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'));

function runtime(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'gpt-relay-observer-'));
  const database = path.join(root, 'runtime.sqlite');
  const store = new SQLiteRuntimeStore(database);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, database, store };
}

test('file observer publishes each contract revision once and resumes from its durable cursor', async (t) => {
  const { root, database, store } = runtime(t);
  const taskPath = path.join(root, 'ACTIVE_TASK.json');
  const task = JSON.parse(readFileSync(path.join(repositoryRoot, 'examples/contracts/task-contract-vnext.example.json'), 'utf8'));
  writeFileSync(taskPath, JSON.stringify(task));

  const pipeline = new RelayPipeline({ store });
  const observer = new FileContractObserver({ store, pipeline });
  const first = await observer.scanOnce(taskPath);
  assert.equal(first.status, 'routed');
  assert.equal(first.event.type, 'task.created');
  assert.equal(await observer.scanOnce(taskPath), null);
  store.close();

  const reopened = new SQLiteRuntimeStore(database);
  t.after(() => reopened.close());
  const resumedObserver = new FileContractObserver({
    store: reopened,
    pipeline: new RelayPipeline({ store: reopened })
  });
  assert.equal(await resumedObserver.scanOnce(taskPath), null, 'restart must resume after the persisted revision');

  task.metadata.attempt = 2;
  writeFileSync(taskPath, JSON.stringify(task));
  const resumed = await resumedObserver.scanOnce(taskPath);
  assert.equal(resumed.event.type, 'task.resumed');
  assert.equal(reopened.listEvents({ workflowRunId: 'W-T-104' }).length, 2);
  reopened.close();
});

test('session registry resumes only the exact task binding and increments generation', (t) => {
  const { store } = runtime(t);
  const registry = new SessionRegistry(store);
  registry.bind({
    session_id: 'S-1',
    executor_id: 'codex',
    workspace_id: 'WS-1',
    task_id: 'T-1',
    conversation_root_id: 'C-1',
    head_attempt_id: 'A-1',
    status: 'READY',
    generation: 1
  });

  assert.equal(registry.forTask('T-1', 'codex').session_id, 'S-1');
  assert.equal(registry.forTask('T-2', 'codex'), null);
  const resumed = registry.prepareResume('T-1', 'codex', 'A-2');
  assert.equal(resumed.generation, 2);
  assert.equal(resumed.head_attempt_id, 'A-2');
  assert.equal(resumed.status, 'RUNNING');
  assert.throws(
    () => registry.bind({ ...resumed, task_id: 'T-other' }),
    /cannot rebind session S-1/
  );
});

test('process supervisor marks missing processes as lost during restart reconciliation', async (t) => {
  const { store } = runtime(t);
  const sessions = new SessionRegistry(store);
  const supervisor = new ProcessSupervisor({
    sessions,
    isAlive: async (pid) => pid === 111
  });
  supervisor.register({
    pid: 111,
    session: {
      session_id: 'S-live', executor_id: 'codex', workspace_id: 'WS-1', task_id: 'T-1',
      conversation_root_id: 'C-1', head_attempt_id: 'A-1', status: 'RUNNING', generation: 1
    }
  });
  supervisor.register({
    pid: 222,
    session: {
      session_id: 'S-dead', executor_id: 'codex', workspace_id: 'WS-1', task_id: 'T-2',
      conversation_root_id: 'C-2', head_attempt_id: 'A-2', status: 'RUNNING', generation: 1
    }
  });

  // Simulate a daemon restart: the new supervisor has no in-memory process map
  // and must reconstruct non-terminal handles from the durable session rows.
  const restarted = new ProcessSupervisor({
    sessions,
    isAlive: async (pid) => pid === 111
  });
  const report = await restarted.reconcile();
  assert.deepEqual(report, { alive: ['S-live'], lost: ['S-dead'] });
  assert.equal(store.getSession('S-live').status, 'RUNNING');
  assert.equal(store.getSession('S-dead').status, 'LOST');
});
