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

function taskContract() {
  return {
    id: 'handoff-001',
    mode: 'IMPLEMENT',
    source_branch: 'main',
    source_commit: 'abc123',
    objective: 'Validate the executor handoff.',
    context: '',
    allowed_changes: ['src/**', 'docs/agent-results/handoff-001-result.json'],
    forbidden_changes: ['unrelated files'],
    validation: ['node --test'],
    acceptance_criteria: ['handoff is internally consistent'],
    result_contract: 'docs/agent-results/handoff-001-result.json',
    completion_commit_contract: [
      'src/**',
      'docs/agent-results/handoff-001-result.json',
      'docs/agent-tasks/ACTIVE_TASK.json'
    ],
    delete_active_task_on_completion: true
  };
}

function resultContract() {
  return {
    task_id: 'handoff-001',
    source_commit: 'abc123',
    result_commit: null,
    status: 'PASS',
    summary: 'Handoff fixture.',
    changed_files: ['src/feature.mjs', 'docs/agent-results/handoff-001-result.json'],
    tests: [{ name: 'node --test', status: 'PASS', evidence: 'fixture' }],
    blockers: [],
    result_path: 'docs/agent-results/handoff-001-result.json',
    notes: []
  };
}

function fixture() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workflow-handoff-'));
  const taskFile = path.join(target, 'docs', 'agent-tasks', 'ACTIVE_TASK.json');
  const resultFile = path.join(target, 'docs', 'agent-results', 'handoff-001-result.json');
  writeJson(taskFile, taskContract());
  writeJson(resultFile, resultContract());
  return { target, taskFile, resultFile };
}

function validateHandoff({ target, taskFile, resultFile }) {
  return run([
    'validate', 'handoff',
    '--task', taskFile,
    '--result', resultFile,
    '--target', target
  ], target);
}

test('validate handoff accepts matching task and result contracts', () => {
  const files = fixture();
  try {
    const result = validateHandoff(files);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /valid handoff/i);
  } finally {
    fs.rmSync(files.target, { recursive: true, force: true });
  }
});

for (const mismatch of [
  {
    name: 'task_id',
    expected: /task_id/i,
    mutate(_task, result) { result.task_id = 'another-task'; }
  },
  {
    name: 'result_path',
    expected: /result_path/i,
    mutate(_task, result) { result.result_path = 'docs/agent-results/another-result.json'; }
  },
  {
    name: 'source_commit',
    expected: /source_commit/i,
    mutate(_task, result) { result.source_commit = 'different-source'; }
  },
  {
    name: 'changed_files',
    expected: /changed_files/i,
    mutate(_task, result) { result.changed_files.push('secrets.txt'); }
  },
  {
    name: 'allowed_changes',
    expected: /allowed_changes/i,
    mutate(task, result) {
      task.allowed_changes = ['src/safe.mjs', task.result_contract];
      task.completion_commit_contract = ['src/**', task.result_contract, 'docs/agent-tasks/ACTIVE_TASK.json'];
      result.changed_files[0] = 'src/evil.mjs';
    }
  }
]) {
  test(`validate handoff rejects mismatched ${mismatch.name}`, () => {
    const files = fixture();
    try {
      const task = JSON.parse(fs.readFileSync(files.taskFile, 'utf8'));
      const resultContractValue = JSON.parse(fs.readFileSync(files.resultFile, 'utf8'));
      mismatch.mutate(task, resultContractValue);
      writeJson(files.taskFile, task);
      writeJson(files.resultFile, resultContractValue);

      const result = validateHandoff(files);
      assert.notEqual(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, mismatch.expected);
    } finally {
      fs.rmSync(files.target, { recursive: true, force: true });
    }
  });
}
