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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('BLOCKED task remains active and resume creates a new result attempt without overwriting evidence', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workflow-resume-'));
  try {
    assert.equal(run(['install', target]).status, 0);
    assert.equal(run([
      'task', 'create', '--target', target, '--id', 'resume-001', '--mode', 'IMPLEMENT',
      '--source-branch', 'main', '--source-commit', 'abc123', '--objective', 'Resume safely.',
      '--allow', 'src/**', '--validate', 'node --test', '--accept', 'work completes'
    ]).status, 0);

    const activePath = path.join(target, 'docs', 'agent-tasks', 'ACTIVE_TASK.json');
    const task = JSON.parse(fs.readFileSync(activePath, 'utf8'));
    const oldResultPath = path.join(target, ...task.result_contract.split('/'));
    writeJson(oldResultPath, {
      task_id: task.id,
      source_commit: task.source_commit,
      result_commit: null,
      status: 'BLOCKED',
      summary: 'Waiting for an external capability.',
      changed_files: [task.result_contract],
      tests: [{ name: 'node --test', status: 'BLOCKED', evidence: 'credential unavailable' }],
      blockers: ['credential unavailable'],
      result_path: task.result_contract,
      notes: []
    });

    const status = run(['status', '--target', target, '--json'], target);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal(JSON.parse(status.stdout).state, 'BLOCKED');
    assert.equal(fs.existsSync(activePath), true);

    const resume = run(['task', 'resume', '--target', target], target);
    assert.equal(resume.status, 0, resume.stderr || resume.stdout);
    assert.equal(fs.existsSync(oldResultPath), true);

    const resumed = JSON.parse(fs.readFileSync(activePath, 'utf8'));
    assert.equal(resumed.metadata.attempt, 2);
    assert.equal(resumed.metadata.resumed_from, task.result_contract);
    assert.equal(resumed.result_contract, 'docs/agent-results/resume-001-attempt-2-result.json');
    assert.ok(resumed.allowed_changes.includes(resumed.result_contract));
    assert.ok(!resumed.allowed_changes.includes(task.result_contract));
    assert.ok(resumed.completion_commit_contract.includes(resumed.result_contract));
    assert.ok(!resumed.completion_commit_contract.includes(task.result_contract));
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});
