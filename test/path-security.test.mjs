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
      ['--allow', 'C:outside/**'],
      ['--allow', 'docs/file:stream'],
      ['--allow', 'CON/file.txt'],
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

test('uninstall refuses manifest entries outside the workflow managed allowlist', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workflow-manifest-tamper-'));
  try {
    fs.writeFileSync(path.join(target, 'README.md'), 'preserve me\n');
    assert.equal(run(['install', target]).status, 0);
    const manifestPath = path.join(target, 'docs', '.agent-workflow-install.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.generated_files.push('README.md');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const uninstall = run(['uninstall', target]);
    assert.notEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
    assert.equal(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), 'preserve me\n');
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('uninstall validates every managed directory before deleting any file', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workflow-dir-tamper-'));
  try {
    assert.equal(run(['install', target]).status, 0);
    const manifestPath = path.join(target, 'docs', '.agent-workflow-install.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.generated_dirs ??= [];
    manifest.generated_dirs.push('unmanaged-empty');
    fs.mkdirSync(path.join(target, 'unmanaged-empty'));
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const uninstall = run(['uninstall', target]);
    assert.notEqual(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
    assert.equal(fs.existsSync(path.join(target, 'docs', 'agent-workflow.md')), true);
    assert.equal(fs.existsSync(manifestPath), true);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('installer refuses to write managed files through a directory symlink or junction', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workflow-link-target-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workflow-link-outside-'));
  try {
    fs.symlinkSync(outside, path.join(target, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
    const install = run(['install', target]);
    assert.notEqual(install.status, 0, install.stderr || install.stdout);
    assert.match(install.stderr, /symbolic link|junction|unsafe managed path/i);
    assert.equal(fs.existsSync(path.join(outside, 'agent-workflow.md')), false);
    assert.equal(fs.existsSync(path.join(outside, '.agent-workflow-install.json')), false);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
