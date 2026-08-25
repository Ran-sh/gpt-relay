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
  assert.deepEqual(events, ['thread.started', 'executor.progress', 'executor.completed']);
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

test('Claude adapter rejects unauthorized capabilities before spawning', async () => {
  const denied = structuredClone(task);
  denied.required_capabilities.push('network');
  denied.delegated_scope.required_capabilities.push('network');
  denied.authorization.network = false;
  const adapter = new ClaudeAdapter({
    cli: process.execPath,
    cliArgs: [fixture],
    workspaceBoundary: boundary
  });

  await assert.rejects(
    adapter.start(denied, { cwd: process.cwd() }),
    /authorization denies network/
  );
});

test('Claude adapter streams session events before the process exits', async () => {
  const adapter = new ClaudeAdapter({
    cli: process.execPath,
    cliArgs: [fixture],
    environment: { FAKE_CLAUDE_DELAY_EXIT_MS: '1000' },
    workspaceBoundary: boundary
  });
  const handle = await adapter.start(task, { cwd: process.cwd() });
  const iterator = adapter.events(handle)[Symbol.asyncIterator]();
  const first = await Promise.race([
    iterator.next(),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 300))
  ]);

  if (first.timedOut) await adapter.cancel(handle);
  assert.equal(first.timedOut, undefined, 'session event must be observable while the child is still alive');
  assert.equal(first.value.type, 'thread.started');
  for await (const _event of { [Symbol.asyncIterator]: () => iterator }) {}
  await adapter.collectResult(handle);
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
