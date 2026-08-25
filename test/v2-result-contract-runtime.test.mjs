import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateRuntimeResultContract } from '../lib/contracts/result.mjs';
import { ResultContractService } from '../lib/runtime/result-contract-service.mjs';

const at = (value) => new Date(value);

function input(overrides = {}) {
  return {
    task: {
      id: 'task-result-1',
      result_contract: 'docs/agent-results/task-result-1.json'
    },
    status: 'PASS',
    summary: 'Implemented and verified the requested change.',
    timeline: {
      started_at: '2026-08-25T01:00:00Z',
      completed_at: '2026-08-25T01:01:00Z'
    },
    tests: [{ name: 'node --test', status: 'PASS', evidence: '12 tests passed' }],
    blockers: [],
    artifacts: [{ path: 'coverage/lcov.info', kind: 'coverage' }],
    evidence: [{ kind: 'commit', summary: 'GREEN checkpoint', ref: 'abc123' }],
    ...overrides
  };
}

test('ResultContractService validates and atomically writes the task-owned result path', () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'gpt-relay-result-'));
  const service = new ResultContractService({ workspace, now: () => at('2026-08-25T01:01:00Z') });
  try {
    const written = service.write(input());
    const absolute = path.join(workspace, 'docs', 'agent-results', 'task-result-1.json');

    assert.equal(written.status, 'written');
    assert.equal(written.path, absolute);
    assert.equal(written.contract.task_id, 'task-result-1');
    assert.equal(written.contract.result_path, 'docs/agent-results/task-result-1.json');
    assert.deepEqual(validateRuntimeResultContract(written.contract), []);
    assert.deepEqual(JSON.parse(readFileSync(absolute, 'utf8')), written.contract);
    assert.equal(existsSync(`${absolute}.tmp`), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('ResultContractService is idempotent for identical content and fails closed on conflict', () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'gpt-relay-result-'));
  const service = new ResultContractService({ workspace });
  try {
    assert.equal(service.write(input()).status, 'written');
    assert.equal(service.write(input()).status, 'unchanged');
    assert.throws(
      () => service.write(input({ summary: 'Conflicting replacement.' })),
      /conflict/i
    );
    const stored = JSON.parse(readFileSync(
      path.join(workspace, 'docs', 'agent-results', 'task-result-1.json'),
      'utf8'
    ));
    assert.equal(stored.summary, 'Implemented and verified the requested change.');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('ResultContractService rejects traversal, wrong directories, malformed evidence, and reversed time', () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'gpt-relay-result-'));
  const service = new ResultContractService({ workspace });
  try {
    for (const result_contract of [
      '../outside.json',
      'docs/result.json',
      'docs/agent-results/../outside.json',
      'docs\\agent-results\\outside.json'
    ]) {
      assert.throws(() => service.write(input({
        task: { id: 'task-result-1', result_contract }
      })), /result_contract|result path/i);
    }
    assert.throws(() => service.write(input({ evidence: [{ kind: '', summary: '' }] })), /evidence/i);
    assert.throws(() => service.write(input({
      timeline: {
        started_at: '2026-08-25T01:02:00Z',
        completed_at: '2026-08-25T01:01:00Z'
      }
    })), /timeline/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
