import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeHost } from '../lib/runtime/runtime-host.mjs';

test('runtime host wires sources, schedules, jobs, and notifications in deterministic order', async () => {
  const calls = [];
  const enqueued = [];
  const host = new RuntimeHost({
    store: {
      enqueueJob(job) { calls.push('schedule.enqueue'); enqueued.push(job); return true; },
      listAttention() { calls.push('attention.list'); return [{ attention_id: 'ATT-1' }]; }
    },
    sourceRegistry: {
      async refresh() { calls.push('sources.refresh'); },
      observers() {
        calls.push('sources.observers');
        return [{ id: 'file-1', async scanOnce() { calls.push('sources.scan'); return true; } }];
      }
    },
    scheduleEngine: {
      tick() {
        calls.push('schedule.tick');
        return [{ occurrence_id: 'S-1@now', schedule_id: 'S-1', task: { id: 'T-scheduled' } }];
      }
    },
    runtimeService: { async runOnce() { calls.push('runtime.run'); return { jobs_completed: 1 }; }, close() {} },
    notifier: {
      enqueue() { calls.push('notification.enqueue'); return 1; },
      async drain() { calls.push('notification.drain'); return { delivered: 1, failed: 0 }; }
    }
  });

  const report = await host.runOnce();
  assert.deepEqual(calls, [
    'sources.refresh', 'sources.observers', 'sources.scan',
    'schedule.tick', 'schedule.enqueue', 'runtime.run',
    'attention.list', 'notification.enqueue', 'notification.drain'
  ]);
  assert.equal(enqueued[0].job_id, 'J-schedule-S-1@now');
  assert.equal(enqueued[0].type, 'scheduled.task');
  assert.equal(report.sources.changed, 1);
});

test('runtime host isolates source errors and keeps later phases running', async () => {
  let ran = false;
  const host = new RuntimeHost({
    store: { enqueueJob() {}, listAttention() { return []; } },
    sourceRegistry: {
      async refresh() {},
      observers() { return [{ id: 'broken', async scanOnce() { throw new Error('offline'); } }]; }
    },
    runtimeService: { async runOnce() { ran = true; return {}; }, close() {} }
  });
  const report = await host.runOnce();
  assert.equal(ran, true);
  assert.equal(report.sources.errors[0].source_id, 'broken');
});
