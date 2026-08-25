import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { IsolatedCopyWorkspaceBoundary } from '../lib/executors/isolated-copy-boundary.mjs';

test('isolated copy boundary applies only authorized files and discards the rest', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'gpt-relay-boundary-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'result.txt'), 'before');
  writeFileSync(path.join(root, 'src', 'secret.txt'), 'protected');

  const boundary = new IsolatedCopyWorkspaceBoundary();
  const execution = await boundary.prepare({
    cwd: root,
    task: {
      delegated_scope: { allowed_changes: ['docs/result.txt'], forbidden_changes: ['src/**'] },
      authorization: { destructive_operations: false }
    }
  });
  assert.notEqual(execution.cwd, root);
  assert.ok(execution.environment.HOME || execution.environment.USERPROFILE);
  writeFileSync(path.join(execution.cwd, 'docs', 'result.txt'), 'after');
  writeFileSync(path.join(execution.cwd, 'src', 'secret.txt'), 'tampered');
  writeFileSync(path.join(execution.cwd, 'outside.txt'), 'not allowed');

  const report = await execution.finalize({ success: true });
  assert.equal(readFileSync(path.join(root, 'docs', 'result.txt'), 'utf8'), 'after');
  assert.equal(readFileSync(path.join(root, 'src', 'secret.txt'), 'utf8'), 'protected');
  assert.equal(existsSync(path.join(root, 'outside.txt')), false);
  assert.deepEqual(report.applied, ['docs/result.txt']);
  assert.deepEqual(report.discarded.sort(), ['outside.txt', 'src/secret.txt']);
  assert.equal(existsSync(execution.cwd), false);
});

test('boundary rejects concurrent source changes instead of overwriting them', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'gpt-relay-boundary-conflict-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'result.txt'), 'baseline');
  const execution = await new IsolatedCopyWorkspaceBoundary().prepare({
    cwd: root,
    task: {
      delegated_scope: { allowed_changes: ['result.txt'], forbidden_changes: ['secrets/**'] },
      authorization: { credentials: false, destructive_operations: false }
    }
  });
  writeFileSync(path.join(execution.cwd, 'result.txt'), 'agent');
  writeFileSync(path.join(root, 'result.txt'), 'user');
  await assert.rejects(execution.finalize({ success: true }), /source changed concurrently/);
  assert.equal(readFileSync(path.join(root, 'result.txt'), 'utf8'), 'user');
});

test('credential-denied boundary excludes workspace secret files', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'gpt-relay-boundary-secret-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, '.env'), 'TOKEN=secret');
  writeFileSync(path.join(root, '.npmrc'), '//registry/:_authToken=secret');
  writeFileSync(path.join(root, 'visible.txt'), 'safe');
  const execution = await new IsolatedCopyWorkspaceBoundary().prepare({
    cwd: root,
    task: {
      delegated_scope: { allowed_changes: [], forbidden_changes: ['**/*.key'] },
      authorization: { credentials: false, destructive_operations: false }
    }
  });
  assert.equal(existsSync(path.join(execution.cwd, '.env')), false);
  assert.equal(existsSync(path.join(execution.cwd, '.npmrc')), false);
  assert.equal(readFileSync(path.join(execution.cwd, 'visible.txt'), 'utf8'), 'safe');
  await execution.finalize({ success: true });
});

test('boundary never follows a source destination symlink', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'gpt-relay-boundary-link-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'gpt-relay-boundary-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const linked = path.join(root, 'result.txt');
  const external = path.join(outside, 'external.txt');
  writeFileSync(external, 'external');
  try {
    symlinkSync(external, linked, 'file');
  } catch (error) {
    t.skip(`symlink unavailable: ${error.code}`);
    return;
  }
  const execution = await new IsolatedCopyWorkspaceBoundary().prepare({
    cwd: root,
    task: {
      delegated_scope: { allowed_changes: ['result.txt'], forbidden_changes: ['secrets/**'] },
      authorization: { credentials: false, destructive_operations: false }
    }
  });
  writeFileSync(path.join(execution.cwd, 'result.txt'), 'agent');
  const report = await execution.finalize({ success: true });
  assert.equal(readFileSync(external, 'utf8'), 'external');
  assert.deepEqual(report.applied, []);
  assert.deepEqual(report.discarded, ['result.txt']);
});
