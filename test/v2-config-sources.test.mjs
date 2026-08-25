import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfigFile, resolveEffectiveConfig } from '../lib/config/loader.mjs';
import { FileContractObserver } from '../lib/relay/observer.mjs';
import { GitObserver } from '../lib/relay/git-observer.mjs';
import { SourceRegistry } from '../lib/relay/source-registry.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

test('source configs persist monotonically without secret values', () => {
  const store = new SQLiteRuntimeStore(':memory:');
  const first = store.upsertSourceConfig({
    source_id: 'tasks', type: 'file', enabled: true,
    config: { path: 'tasks/task.json' }, secret_env: { token: 'TASK_SOURCE_TOKEN' }
  });
  const second = store.upsertSourceConfig({
    source_id: 'tasks', type: 'file', enabled: false,
    config: { path: 'tasks/next.json' }, secret_env: { token: 'TASK_SOURCE_TOKEN' }
  });

  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(store.getSourceConfig('tasks').config.path, 'tasks/next.json');
  assert.deepEqual(store.listSourceConfigs({ enabledOnly: true }), []);
  assert.equal(store.setSourceConfigEnabled('tasks', true).revision, 3);
  assert.throws(() => store.upsertSourceConfig({
    source_id: 'unsafe', type: 'git', config: { token: 'plaintext' }
  }), /secret.*env/i);
  assert.throws(() => store.upsertSourceConfig({
    source_id: 'unsafe-env', type: 'git', config: {}, secret_env: { token: 'literal-secret' }
  }), /environment variable/i);
  store.close();
});

test('config snapshots are immutable and queryable', () => {
  const store = new SQLiteRuntimeStore(':memory:');
  const snapshot = store.saveConfigSnapshot({
    snapshot_id: 'CFG-1', scope: 'workflow', scope_id: 'W-1',
    config: { budget: { tokens: 500 } }
  });
  assert.equal(snapshot.revision, 1);
  assert.deepEqual(store.getConfigSnapshot('CFG-1').config, { budget: { tokens: 500 } });
  assert.throws(() => store.saveConfigSnapshot({
    snapshot_id: 'CFG-1', scope: 'workflow', scope_id: 'W-1', config: {}
  }), /already exists/i);
  assert.equal(store.listConfigSnapshots({ scope: 'workflow', scopeId: 'W-1' }).length, 1);
  store.close();
});

test('workspace and workflow config resolve fail-closed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'relay-config-'));
  const workspacePath = path.join(root, 'workspace.json');
  writeFileSync(workspacePath, JSON.stringify({
    authorization: { shell: true, network: false, git_push: false },
    budget: { tokens: 10_000, cost_usd: 5 },
    allowed_changes: ['src/**', 'test/**']
  }));
  const workspace = loadConfigFile(workspacePath);
  const effective = resolveEffectiveConfig({
    workspace,
    workflow: {
      authorization: { shell: false, network: true, git_push: true },
      budget: { tokens: 2_000, cost_usd: 8 },
      allowed_changes: ['src/feature/**']
    },
    task: {
      authorization: { shell: true, network: true, git_push: true },
      budget: { tokens: 3_000 },
      allowed_changes: ['src/feature/api.mjs']
    }
  });

  assert.deepEqual(effective.authorization, { shell: false, network: false, git_push: false });
  assert.deepEqual(effective.budget, { tokens: 2_000, cost_usd: 5 });
  assert.deepEqual(effective.allowed_changes, ['src/feature/api.mjs']);
  assert.throws(() => resolveEffectiveConfig({
    workspace,
    workflow: { allowed_changes: ['docs/**'] },
    task: { allowed_changes: ['docs/readme.md'] }
  }), /expand.*scope/i);
  assert.throws(() => resolveEffectiveConfig({
    workspace, workflow: {}, task: { allowed_changes: ['src/**'] }
  }), /expand.*scope/i);
});

test('SourceRegistry constructs only enabled in-workspace file and git observers', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'relay-sources-'));
  mkdirSync(path.join(root, 'repo'));
  writeFileSync(path.join(root, 'task.json'), '{}');
  const store = new SQLiteRuntimeStore(':memory:');
  store.upsertSourceConfig({ source_id: 'file-1', type: 'file', enabled: true, config: { path: 'task.json' } });
  store.upsertSourceConfig({ source_id: 'git-1', type: 'git', enabled: true, config: { path: 'repo' } });
  store.upsertSourceConfig({ source_id: 'off', type: 'file', enabled: false, config: { path: 'ignored.json' } });
  const registry = new SourceRegistry({ store, pipeline: { accept() {} }, workspaceRoot: root });
  const sources = registry.buildEnabled();

  assert.equal(sources.length, 2);
  assert.ok(sources.some((entry) => entry.source_id === 'file-1' && entry.observer instanceof FileContractObserver));
  assert.ok(sources.some((entry) => entry.source_id === 'git-1' && entry.observer instanceof GitObserver));

  store.upsertSourceConfig({ source_id: 'escape', type: 'file', enabled: true, config: { path: '../outside.json' } });
  assert.throws(() => registry.buildEnabled(), /workspace root/i);
  store.close();
});
