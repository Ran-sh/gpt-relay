import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { runCodexSmoke } from '../lib/doctor/codex-smoke.mjs';
import { FakeExecutor } from '../lib/executors/fake.mjs';

test('Codex doctor is detection-only unless live execution is explicit', async () => {
  const executor = new FakeExecutor({
    capabilities: ['local.shell'],
    result: { status: 'PASS', summary: 'ok', session_id: 'S-smoke' }
  });
  const report = await runCodexSmoke({ adapter: executor, live: false });
  assert.equal(report.live, false);
  assert.equal(report.ready, true);
  assert.deepEqual(executor.stats(), { starts: 0, resumes: 0, cancels: 0 });
});

test('live Codex smoke uses a temporary read-only task and cleans its workspace', async () => {
  let observedCwd;
  const executor = new FakeExecutor({
    capabilities: ['local.shell'],
    events: [{ id: 'done', type: 'turn.completed' }],
    result: { status: 'PASS', summary: 'SMOKE_OK', session_id: 'S-smoke' }
  });
  const originalStart = executor.start.bind(executor);
  executor.start = async (task, context) => {
    observedCwd = context.cwd;
    assert.deepEqual(task.delegated_scope.allowed_changes, []);
    assert.equal(task.authorization.credentials, false);
    assert.equal(task.authorization.network, false);
    return originalStart(task, context);
  };
  const report = await runCodexSmoke({ adapter: executor, live: true, timeoutMs: 2_000 });
  assert.equal(report.status, 'PASS');
  assert.equal(report.summary, 'SMOKE_OK');
  assert.equal(existsSync(observedCwd), false);
});
