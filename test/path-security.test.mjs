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

function removeActiveTask(target) {
  fs.rmSync(path.join(target, 'docs', 'agent-tasks', 'ACTIVE_TASK.json'), { force: true });
  fs.rmSync(path.join(target, 'docs', 'agent-tasks', 'ACTIVE_TASK.md'), { force: true });
}

function createArgs(target, option, candidate) {
  return [
    'task', 'create',
    '--target', target,
    '--id', 'path-security-001',
    '--mode', 'IMPLEMENT',
    '--source-branch', 'main',
    '--source-commit', 'abc123',
    '--objective', 'Exercise managed path validation.',
    '--allow', 'src/**',
    '--validate', 'node --test',
    '--accept', 'unsafe paths are rejected',
    option, candidate
  ];
}

test('task creation rejects traversal and absolute paths in managed path options', async (t) => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workflow-paths-'));
  try {
    const install = run(['install', target]);
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const cases = [
      ['--result', 'docs/agent-results/../../outside.json'],
      ['--result', 'C:\\temp\\outside.json'],
      ['--result', '\\\\server\\share\\outside.json'],
      ['--allow', '../outside/**'],
      ['--allow', 'C:\\temp\\outside/**'],
      ['--allow', '\\\\server\\share\\outside/**'],
      ['--complete', '../outside.json'],
      ['--complete', 'C:\\temp\\outside.json'],
      ['--complete', '\\\\server\\share\\outside.json']
    ];

    for (const [option, candidate] of cases) {
      await t.test(`${option} rejects ${candidate}`, () => {
        try {
          const result = run(createArgs(target, option, candidate));
          assert.notEqual(result.status, 0, result.stderr || result.stdout);
          assert.match(result.stderr, /unsafe managed path|must be under/i);
        } finally {
          removeActiveTask(target);
        }
      });
    }
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});
