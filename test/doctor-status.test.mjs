import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'agent-workflow.mjs');

function run(args, cwd = root) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
}

test('doctor --json reports installation, ACTIVE task, and dirty worktree status', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workflow-doctor-'));
  try {
    assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: target, encoding: 'utf8' }).status, 0);
    fs.writeFileSync(path.join(target, 'README.md'), '# fixture\n');
    assert.equal(spawnSync('git', ['add', 'README.md'], { cwd: target, encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', [
      '-c', 'user.name=Agent Workflow Tests',
      '-c', 'user.email=tests@example.invalid',
      'commit', '-m', 'fixture'
    ], { cwd: target, encoding: 'utf8' }).status, 0);

    const install = run(['install', target]);
    assert.equal(install.status, 0, install.stderr || install.stdout);
    const create = run([
      'task', 'create',
      '--target', target,
      '--id', 'doctor-001',
      '--mode', 'REVIEW_ONLY',
      '--source-branch', 'main',
      '--source-commit', 'abc123',
      '--objective', 'Exercise doctor status.',
      '--validate', 'inspect files',
      '--accept', 'status is reported'
    ]);
    assert.equal(create.status, 0, create.stderr || create.stdout);

    const doctor = run(['doctor', '--target', target, '--json'], target);
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.installation.installed, true);
    assert.equal(report.active_task.present, true);
    assert.equal(report.active_task.valid, true);
    assert.equal(report.worktree.is_git_repository, true);
    assert.equal(report.worktree.clean, false);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('doctor fails closed when an installed runtime artifact is missing', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workflow-doctor-incomplete-'));
  try {
    assert.equal(run(['install', target]).status, 0);
    fs.rmSync(path.join(target, '.agent-workflow', 'lib', 'path-policy.mjs'));
    const doctor = run(['doctor', '--target', target, '--json'], target);
    assert.notEqual(doctor.status, 0, doctor.stderr || doctor.stdout);
    assert.equal(JSON.parse(doctor.stdout).installation.valid, false);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('status rejects a valid Result Contract that belongs to another task', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workflow-status-mismatch-'));
  try {
    assert.equal(run(['install', target]).status, 0);
    assert.equal(run([
      'task', 'create', '--target', target, '--id', 'status-001', '--mode', 'REVIEW_ONLY',
      '--source-branch', 'main', '--source-commit', 'abc123', '--objective', 'Check status identity.',
      '--validate', 'inspect files', '--accept', 'identity matches'
    ]).status, 0);
    const resultPath = path.join(target, 'docs', 'agent-results', 'status-001-result.json');
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(resultPath, `${JSON.stringify({
      task_id: 'different-task', source_commit: 'abc123', result_commit: null, status: 'PASS',
      changed_files: ['docs/agent-results/status-001-result.json'],
      tests: [{ name: 'inspect files', status: 'PASS' }], blockers: [],
      result_path: 'docs/agent-results/status-001-result.json'
    }, null, 2)}\n`);
    const status = run(['status', '--target', target, '--json'], target);
    assert.notEqual(status.status, 0, status.stderr || status.stdout);
    assert.equal(JSON.parse(status.stdout).state, 'INVALID');
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});
