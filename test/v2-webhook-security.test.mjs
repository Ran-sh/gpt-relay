import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { GitHubWebhookSource } from '../lib/relay/github-webhook.mjs';
import { RelayPipeline } from '../lib/relay/pipeline.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

function signature(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

test('GitHub webhook validates HMAC, deduplicates delivery IDs, and maps CI failure', async (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  const source = new GitHubWebhookSource({
    secret: 'webhook-secret', store, pipeline: new RelayPipeline({ store }), maxBytes: 10_000
  });
  const body = Buffer.from(JSON.stringify({
    action: 'completed',
    workflow_run: { id: 42, conclusion: 'failure', html_url: 'https://github.test/run/42' },
    repository: { full_name: 'Ran-sh/gpt-relay' }
  }));
  const headers = {
    'x-github-delivery': 'delivery-1',
    'x-github-event': 'workflow_run',
    'x-hub-signature-256': signature('webhook-secret', body)
  };
  const first = await source.accept({ headers, body }, { workflow_run_id: 'W-hook', task_id: 'T-hook' });
  assert.equal(first.status, 'routed');
  assert.equal(first.event.type, 'github.ci_failed');
  assert.equal((await source.accept({ headers, body }, { workflow_run_id: 'W-hook', task_id: 'T-hook' })).status, 'duplicate');
  assert.equal(store.listEvents({ workflowRunId: 'W-hook' }).length, 1);

  await assert.rejects(source.accept({
    headers: { ...headers, 'x-github-delivery': 'delivery-2', 'x-hub-signature-256': 'sha256=bad' }, body
  }, { workflow_run_id: 'W-hook' }), /signature/i);
});

test('GitHub delivery ID collision with changed payload fails closed', async (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  const source = new GitHubWebhookSource({
    secret: 'secret', store, pipeline: new RelayPipeline({ store })
  });
  const headers = { 'x-github-delivery': 'same', 'x-github-event': 'pull_request' };
  const firstBody = Buffer.from(JSON.stringify({ action: 'opened', pull_request: { number: 1 } }));
  await source.accept({
    headers: { ...headers, 'x-hub-signature-256': signature('secret', firstBody) }, body: firstBody
  }, { workflow_run_id: 'W-pr' });
  const changedBody = Buffer.from(JSON.stringify({ action: 'closed', pull_request: { number: 1 } }));
  await assert.rejects(source.accept({
    headers: { ...headers, 'x-hub-signature-256': signature('secret', changedBody) }, body: changedBody
  }, { workflow_run_id: 'W-pr' }), /delivery collision/i);
});
