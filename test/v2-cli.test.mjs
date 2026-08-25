import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'));
const cli = path.join(root, 'bin', 'gpt-relay.mjs');

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    ...options
  });
}

test('package exposes gpt-relay while retaining the legacy agent-workflow command', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@ran-sh/gpt-relay');
  assert.equal(manifest.version, '2.0.0');
  assert.equal(manifest.bin['gpt-relay'], './bin/gpt-relay.mjs');
  assert.equal(manifest.bin['agent-workflow'], './bin/agent-workflow.mjs');
  assert.equal(manifest.engines.node, '>=24');
});

test('runtime CLI initializes and queries durable status, attention, and events', (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'gpt-relay-cli-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const database = path.join(temporary, 'relay.sqlite');

  const initialized = run(['runtime', 'init', '--db', database, '--json']);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(JSON.parse(initialized.stdout).ok, true);

  const store = new SQLiteRuntimeStore(database);
  store.saveWorkflow({ run_id: 'W-cli', objective: 'CLI smoke', state: 'VERIFYING' });
  store.createAttention({
    attention_id: 'ATT-cli',
    workflow_run_id: 'W-cli',
    type: 'APPROVAL',
    message: 'push requested'
  });
  store.appendEvent({
    event_id: 'E-cli',
    workflow_run_id: 'W-cli',
    task_id: 'T-cli',
    attempt_id: 'A-cli',
    source: 'codex',
    type: 'executor.completed',
    timestamp: '2026-08-25T00:00:00Z',
    payload: { status: 'PASS' },
    idempotency_key: 'codex:S-cli:E-cli',
    lane: 'control',
    session_id: 'S-cli',
    generation: 1
  });
  store.close();

  const status = run(['runtime', 'status', '--db', database, '--json']);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).workflows[0].state, 'VERIFYING');

  const attention = run(['runtime', 'attention', '--db', database, '--json']);
  assert.equal(attention.status, 0, attention.stderr);
  assert.equal(JSON.parse(attention.stdout).attention[0].attention_id, 'ATT-cli');

  const events = run(['runtime', 'events', '--db', database, '--workflow', 'W-cli', '--control-only', '--json']);
  assert.equal(events.status, 0, events.stderr);
  assert.equal(JSON.parse(events.stdout).events[0].type, 'executor.completed');
});

test('runtime CLI validates a vNext task without treating capability as authorization', () => {
  const valid = run(['task', 'validate-vnext', 'examples/contracts/task-contract-vnext.example.json', '--json']);
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), { valid: true, errors: [] });

  const canonical = spawnSync(process.execPath, [
    path.join(root, 'validator', 'validate-contract.mjs'),
    'task',
    path.join(root, 'examples', 'contracts', 'task-contract-vnext.example.json')
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(canonical.status, 0, canonical.stderr || canonical.stdout);

  const version = run(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '2.0.0');
});
