import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
