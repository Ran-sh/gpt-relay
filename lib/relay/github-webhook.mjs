import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

function header(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return null;
}

function verifySignature(secret, body, supplied) {
  if (typeof supplied !== 'string' || !supplied.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function canonicalType(eventName, payload) {
  if (eventName === 'pull_request') return 'github.pr_updated';
  if (eventName === 'workflow_run') {
    return payload.workflow_run?.conclusion === 'failure' ? 'github.ci_failed' : 'github.workflow_updated';
  }
  if (eventName === 'check_suite' || eventName === 'check_run') {
    const check = payload.check_suite ?? payload.check_run;
    return check?.conclusion === 'failure' ? 'github.ci_failed' : 'github.check_updated';
  }
  return 'github.event_received';
}

export class GitHubWebhookSource {
  #secret;
  #store;
  #pipeline;
  #maxBytes;

  constructor({ secret, store, pipeline, maxBytes = 1_000_000 }) {
    if (typeof secret !== 'string' || secret.length < 6) throw new Error('GitHub webhook requires a secret');
    if (!store || !pipeline) throw new Error('GitHub webhook requires store and pipeline');
    this.#secret = secret;
    this.#store = store;
    this.#pipeline = pipeline;
    this.#maxBytes = maxBytes;
  }

  async accept({ headers, body }, context = {}) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
    if (bytes.length === 0 || bytes.length > this.#maxBytes) throw new Error('GitHub webhook payload size is invalid');
    if (!verifySignature(this.#secret, bytes, header(headers, 'x-hub-signature-256'))) {
      throw new Error('GitHub webhook signature is invalid');
    }
    const deliveryId = header(headers, 'x-github-delivery');
    const eventName = header(headers, 'x-github-event');
    if (!deliveryId || !eventName) throw new Error('GitHub webhook delivery headers are missing');
    const payloadHash = createHash('sha256').update(bytes).digest('hex');
    const recorded = this.#store.recordExternalDelivery({
      source: 'github', delivery_id: deliveryId, payload_hash: payloadHash, event_type: eventName
    });
    if (recorded === 'duplicate') return { status: 'duplicate', event: null };
    if (recorded === 'collision') throw new Error(`GitHub delivery collision: ${deliveryId}`);
    let payload;
    try {
      payload = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new Error(`GitHub webhook payload is invalid JSON: ${error.message}`);
    }
    return this.#pipeline.accept({
      event_id: `E-github-${deliveryId}`,
      idempotency_key: `github:${deliveryId}`,
      source: 'github',
      type: canonicalType(eventName, payload),
      payload: {
        delivery_id: deliveryId,
        event: eventName,
        action: payload.action ?? null,
        repository: payload.repository?.full_name ?? null,
        conclusion: payload.workflow_run?.conclusion
          ?? payload.check_suite?.conclusion
          ?? payload.check_run?.conclusion
          ?? null,
        url: payload.workflow_run?.html_url ?? payload.pull_request?.html_url ?? null
      }
    }, { ...context, source: 'github' });
  }
}
