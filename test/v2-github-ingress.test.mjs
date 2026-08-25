import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { createGitHubIngressServer } from '../lib/relay/github-ingress-server.mjs';

function signature(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function startIngress(overrides = {}) {
  const configs = new Map([
    ['active', { enabled: true }],
    ['disabled', { enabled: false }],
    ['no-secret', { enabled: true }]
  ]);
  const server = createGitHubIngressServer({
    configResolver: async (sourceId) => configs.get(sourceId) ?? null,
    secretResolver: async (sourceId) => sourceId === 'no-secret' ? null : 'hook-secret',
    sourceFactory: ({ sourceId }) => ({
      accept: async () => ({ status: sourceId === 'duplicate' ? 'duplicate' : 'routed' })
    }),
    contextResolver: async (sourceId) => ({ workflow_run_id: `W-${sourceId}` }),
    maxBytes: 128,
    ...overrides
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function webhookHeaders(body, secret = 'hook-secret') {
  return {
    'content-type': 'application/json',
    'x-github-delivery': 'delivery-1',
    'x-github-event': 'pull_request',
    'x-hub-signature-256': signature(secret, body)
  };
}

test('GitHub ingress exposes only the source-scoped POST endpoint and resolves configuration', async (t) => {
  let received;
  const fixture = await startIngress({
    sourceFactory: (options) => ({
      accept: async (request, context) => {
        received = { options, request, context };
        return { status: 'routed' };
      }
    })
  });
  t.after(fixture.close);
  const body = JSON.stringify({ action: 'opened' });
  const response = await fetch(`${fixture.url}/webhooks/github/active`, {
    method: 'POST', headers: webhookHeaders(body), body
  });

  assert.equal(response.status, 202);
  assert.equal(received.options.sourceId, 'active');
  assert.equal(received.options.secret, 'hook-secret');
  assert.deepEqual(received.request.body, Buffer.from(body));
  assert.equal(received.context.workflow_run_id, 'W-active');
  assert.equal((await fetch(`${fixture.url}/webhooks/github/active`)).status, 405);
  assert.equal((await fetch(`${fixture.url}/other`, { method: 'POST' })).status, 404);
});

test('GitHub ingress reports unknown, disabled, unavailable secret, bad signature, and oversize safely', async (t) => {
  const fixture = await startIngress();
  t.after(fixture.close);
  const body = JSON.stringify({ action: 'opened' });

  assert.equal((await fetch(`${fixture.url}/webhooks/github/missing`, {
    method: 'POST', headers: webhookHeaders(body), body
  })).status, 404);
  assert.equal((await fetch(`${fixture.url}/webhooks/github/disabled`, {
    method: 'POST', headers: webhookHeaders(body), body
  })).status, 404);
  assert.equal((await fetch(`${fixture.url}/webhooks/github/no-secret`, {
    method: 'POST', headers: webhookHeaders(body), body
  })).status, 503);
  assert.equal((await fetch(`${fixture.url}/webhooks/github/active`, {
    method: 'POST', headers: webhookHeaders(body, 'wrong-secret'), body
  })).status, 401);
  const oversized = 'x'.repeat(129);
  assert.equal((await fetch(`${fixture.url}/webhooks/github/active`, {
    method: 'POST', headers: webhookHeaders(oversized), body: oversized
  })).status, 413);
});

test('GitHub ingress maps duplicate, collision, and retryable route failures', async (t) => {
  const attempts = new Map();
  const fixture = await startIngress({
    configResolver: async (sourceId) => ({ enabled: true, sourceId }),
    sourceFactory: ({ sourceId }) => ({
      accept: async () => {
        const attempt = (attempts.get(sourceId) ?? 0) + 1;
        attempts.set(sourceId, attempt);
        if (sourceId === 'duplicate') return { status: 'duplicate' };
        if (sourceId === 'collision') throw new Error('GitHub delivery collision: collision');
        if (sourceId === 'retry' && attempt === 1) throw new Error('router unavailable');
        return { status: 'routed' };
      }
    })
  });
  t.after(fixture.close);
  const body = JSON.stringify({ action: 'opened' });
  const send = (sourceId) => fetch(`${fixture.url}/webhooks/github/${sourceId}`, {
    method: 'POST', headers: webhookHeaders(body), body
  });

  assert.equal((await send('duplicate')).status, 200);
  assert.equal((await send('collision')).status, 409);
  assert.equal((await send('retry')).status, 503);
  assert.equal((await send('retry')).status, 202);
  assert.equal(attempts.get('retry'), 2);
});
