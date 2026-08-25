import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GitObserver } from '../lib/relay/git-observer.mjs';
import { ObserverService } from '../lib/relay/observer-service.mjs';
import { RelayPipeline } from '../lib/relay/pipeline.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

test('Git observer persists HEAD and dirty-status revisions without duplicates', async (t) => {
  const repo = mkdtempSync(path.join(tmpdir(), 'gpt-relay-git-observer-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(path.join(repo, 'file.txt'), 'one');
  execFileSync('git', ['add', 'file.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: repo, stdio: 'ignore' });

  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  const observer = new GitObserver({ store, pipeline: new RelayPipeline({ store }) });
  const first = await observer.scanOnce(repo, { workflow_run_id: 'W-git', task_id: 'T-git' });
  assert.equal(first.event.type, 'git.changed');
  assert.equal(first.event.payload.dirty, false);
  assert.equal(await observer.scanOnce(repo, { workflow_run_id: 'W-git', task_id: 'T-git' }), null);
  writeFileSync(path.join(repo, 'file.txt'), 'two');
  const dirty = await observer.scanOnce(repo, { workflow_run_id: 'W-git', task_id: 'T-git' });
  assert.equal(dirty.event.payload.dirty, true);
  assert.equal(store.listEvents({ workflowRunId: 'W-git' }).length, 2);
});

test('observer service scans all configured sources once and isolates failures', async () => {
  const calls = [];
  const service = new ObserverService({
    observers: [
      { id: 'good', async scanOnce() { calls.push('good'); return { status: 'routed' }; } },
      { id: 'bad', async scanOnce() { calls.push('bad'); throw new Error('broken source'); } }
    ]
  });
  const report = await service.scanOnce();
  assert.deepEqual(calls, ['good', 'bad']);
  assert.equal(report.scanned, 2);
  assert.equal(report.changed, 1);
  assert.deepEqual(report.errors, [{ source_id: 'bad', error: 'broken source' }]);
});
