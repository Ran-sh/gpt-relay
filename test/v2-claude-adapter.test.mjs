import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ClaudeAdapter } from '../lib/executors/claude.mjs';
import { ExecutorRegistry } from '../lib/executors/registry.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const task = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/contracts/task-contract-vnext.example.json', import.meta.url)), 'utf8'));
const boundary = { async prepare({ cwd }) { return { cwd, async finalize() {} }; } };

test('Claude adapter validates structured result and exact resume session', async () => {
  const adapter = new ClaudeAdapter({ cli: process.execPath, cliArgs: [fixture], workspaceBoundary: boundary });
  assert.equal((await adapter.detect()).ready, true);
  const handle = await adapter.start(task, { cwd: process.cwd(), workflow_run_id: 'W', attempt_id: 'A' });
  const events = [];
  for await (const event of adapter.events(handle)) events.push(event.type);
  const result = await adapter.collectResult(handle);
  assert.deepEqual(events, ['session.created', 'executor.progress', 'executor.completed']);
  assert.equal(result.status, 'PASS');
  assert.equal(result.session_id, 'C-new');
  assert.equal(result.total_cost_usd, 0.01);
  assert.ok(handle.args.includes('stream-json'));

  const mismatched = new ClaudeAdapter({
    cli: process.execPath, cliArgs: [fixture], workspaceBoundary: boundary,
    environment: { FAKE_CLAUDE_SESSION_ID: 'C-other' }
  });
  const resumed = await mismatched.resume({ session_id: 'C-expected' }, task, { cwd: process.cwd() });
  for await (const _event of mismatched.events(resumed)) {}
  assert.equal((await mismatched.collectResult(resumed)).session_lost, true);
});

test('executor registry returns an audited deterministic readiness snapshot', async () => {
  const registry = new ExecutorRegistry();
  registry.register(new ClaudeAdapter({ cli: process.execPath, cliArgs: [fixture], workspaceBoundary: boundary }), { priority: 20 });
  const snapshot = await registry.snapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].executor_id, 'claude');
  assert.equal(snapshot[0].ready, true);
  assert.equal(snapshot[0].priority, 20);
  assert.ok(snapshot[0].capabilities.includes('session.resume'));
  assert.match(snapshot[0].detected_at, /^\d{4}-/);
});
