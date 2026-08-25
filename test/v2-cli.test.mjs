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
  assert.equal(manifest.version, '2.4.0');
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.publishConfig.access, 'public');
  assert.equal(manifest.repository.url, 'git+https://github.com/Ran-sh/gpt-relay.git');
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
  assert.equal(version.stdout.trim(), '2.4.0');
});

test('CLI resolves human and approval Attention idempotently and scans a task source', (t) => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'gpt-relay-command-cli-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const database = path.join(temporary, 'relay.sqlite');
  const store = new SQLiteRuntimeStore(database);
  store.saveWorkflow({ run_id: 'W-human-cli', objective: 'Wait', state: 'WAITING_FOR_HUMAN' });
  store.createAttention({
    attention_id: 'ATT-human-cli', workflow_run_id: 'W-human-cli', type: 'DECISION', message: 'Answer'
  });
  store.saveWorkflow({ run_id: 'W-approval-cli', objective: 'Approve', state: 'WAITING_FOR_APPROVAL' });
  store.createAttention({
    attention_id: 'ATT-approval-cli', workflow_run_id: 'W-approval-cli', type: 'APPROVAL', message: 'Approve'
  });
  store.saveWorkflow({ run_id: 'W-paused-cli', objective: 'Recover', state: 'PAUSED' });
  store.close();

  const reply = run([
    'human', 'reply', 'ATT-human-cli', '--text', 'Mode A', '--db', database, '--json'
  ]);
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(JSON.parse(reply.stdout).attention.status, 'RESOLVED');

  const grant = run([
    'approval', 'grant', 'ATT-approval-cli', '--reason', 'approved', '--db', database, '--json'
  ]);
  assert.equal(grant.status, 0, grant.stderr);
  assert.equal(JSON.parse(grant.stdout).attention.response_type, 'approval.granted');

  const resume = run(['workflow', 'resume', 'W-paused-cli', '--db', database, '--json']);
  assert.equal(resume.status, 0, resume.stderr);
  assert.equal(JSON.parse(resume.stdout).job.type, 'workflow.resume_requested');

  const observed = run([
    'source', 'scan-file', path.join(root, 'examples', 'contracts', 'task-contract-vnext.example.json'),
    '--db', database, '--json'
  ]);
  assert.equal(observed.status, 0, observed.stderr);
  assert.equal(JSON.parse(observed.stdout).event.type, 'task.created');

  const reopened = new SQLiteRuntimeStore(database);
  const jobs = reopened.listJobs({ status: 'PENDING' });
  assert.equal(jobs.length, 4);
  assert.equal(jobs.some((job) => job.type === 'task.created' && job.payload.path.endsWith('task-contract-vnext.example.json')), true);
  assert.equal(reopened.listEvents({ workflowRunId: 'W-T-104' }).length, 1);
  reopened.close();
});

test('CLI exposes executor doctor and guards production service configuration', () => {
  const fixture = path.join(root, 'test', 'fixtures', 'fake-codex.mjs');
  const doctor = run([
    'doctor', 'codex', '--cli', process.execPath, '--cli-arg', fixture, '--json'
  ]);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).ready, true);

  const service = run(['service', 'once', '--db', path.join(root, '.ignored-service.sqlite'), '--json'], {
    env: { ...process.env, OPENAI_API_KEY: '' }
  });
  assert.equal(service.status, 1);
  assert.match(service.stderr, /OPENAI_API_KEY/);
});
