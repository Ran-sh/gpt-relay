import assert from 'node:assert/strict';
import test from 'node:test';

import { NotificationDispatcher } from '../lib/runtime/notifier.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

test('notification outbox deduplicates per transport and retries failures independently', async (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  const attention = {
    attention_id: 'ATT-notify', workflow_run_id: 'W-notify', type: 'APPROVAL', message: 'Approval needed'
  };
  store.createAttention(attention);
  let flakyAttempts = 0;
  const delivered = [];
  const dispatcher = new NotificationDispatcher({
    store,
    transports: {
      console: { async send(payload) { delivered.push(`console:${payload.attention_id}`); } },
      flaky: {
        async send(payload) {
          flakyAttempts += 1;
          if (flakyAttempts === 1) throw new Error('temporary failure');
          delivered.push(`flaky:${payload.attention_id}`);
        }
      }
    }
  });
  assert.equal(dispatcher.enqueue(attention, ['console', 'flaky']), 2);
  assert.equal(dispatcher.enqueue(attention, ['console', 'flaky']), 0);
  assert.deepEqual(await dispatcher.drain(), { delivered: 1, failed: 1 });
  assert.deepEqual(await dispatcher.drain(), { delivered: 1, failed: 0 });
  assert.deepEqual(delivered, ['console:ATT-notify', 'flaky:ATT-notify']);
  assert.equal(store.listNotificationDeliveries({ status: 'DELIVERED' }).length, 2);
});
