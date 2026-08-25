import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { GitHubWebhookSource } from './github-webhook.mjs';

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extraHeaders
  });
  response.end(body);
}

function signatureIsValid(secret, body, supplied) {
  if (typeof supplied !== 'string' || !supplied.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function readRawBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      request.resume();
      reject(Object.assign(new Error('payload too large'), { code: 'PAYLOAD_TOO_LARGE' }));
      return;
    }
    const chunks = [];
    let size = 0;
    let oversized = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        oversized = true;
        chunks.length = 0;
      } else if (!oversized) {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      if (oversized) {
        reject(Object.assign(new Error('payload too large'), { code: 'PAYLOAD_TOO_LARGE' }));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    request.on('aborted', () => reject(Object.assign(new Error('request aborted'), { code: 'REQUEST_ABORTED' })));
    request.on('error', reject);
  });
}

function pathSourceId(url) {
  let pathname;
  try {
    pathname = new URL(url, 'http://localhost').pathname;
  } catch {
    return null;
  }
  const match = /^\/webhooks\/github\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  try {
    const sourceId = decodeURIComponent(match[1]);
    return sourceId.length > 0 ? sourceId : null;
  } catch {
    return null;
  }
}

function sourceErrorStatus(error) {
  const message = String(error?.message ?? '');
  if (/delivery collision/i.test(message)) return 409;
  if (/signature.+invalid/i.test(message)) return 401;
  if (/payload size/i.test(message)) return 413;
  if (/headers are missing|invalid JSON/i.test(message)) return 400;
  return 503;
}

export function createGitHubIngressServer({
  configResolver,
  secretResolver,
  sourceFactory = (options) => new GitHubWebhookSource(options),
  contextResolver = async () => ({}),
  maxBytes = 1_000_000
} = {}) {
  if (typeof configResolver !== 'function') throw new TypeError('configResolver must be a function');
  if (typeof secretResolver !== 'function') throw new TypeError('secretResolver must be a function');
  if (typeof sourceFactory !== 'function') throw new TypeError('sourceFactory must be a function');
  if (typeof contextResolver !== 'function') throw new TypeError('contextResolver must be a function');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive integer');

  return createServer(async (request, response) => {
    const sourceId = pathSourceId(request.url);
    if (!sourceId) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      return;
    }

    let config;
    try {
      config = await configResolver(sourceId);
    } catch {
      sendJson(response, 503, { error: 'configuration_unavailable' });
      return;
    }
    if (!config || config.enabled !== true) {
      sendJson(response, 404, { error: 'source_not_found' });
      return;
    }

    let secret;
    try {
      secret = await secretResolver(sourceId, config);
    } catch {
      sendJson(response, 503, { error: 'secret_unavailable' });
      return;
    }
    if (typeof secret !== 'string' || secret.length === 0) {
      sendJson(response, 503, { error: 'secret_unavailable' });
      return;
    }

    let body;
    try {
      body = await readRawBody(request, maxBytes);
    } catch (error) {
      sendJson(response, error?.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, {
        error: error?.code === 'PAYLOAD_TOO_LARGE' ? 'payload_too_large' : 'invalid_request'
      });
      return;
    }
    if (!signatureIsValid(secret, body, request.headers['x-hub-signature-256'])) {
      sendJson(response, 401, { error: 'invalid_signature' });
      return;
    }

    try {
      const context = await contextResolver(sourceId, config);
      const source = sourceFactory({ ...config, sourceId, secret, maxBytes });
      if (!source || typeof source.accept !== 'function') throw new Error('source is unavailable');
      const result = await source.accept({ headers: request.headers, body }, context ?? {});
      if (result?.status === 'collision') {
        sendJson(response, 409, { status: 'collision' });
      } else if (result?.status === 'duplicate') {
        sendJson(response, 200, { status: 'duplicate' });
      } else {
        sendJson(response, 202, { status: 'accepted' });
      }
    } catch (error) {
      const status = sourceErrorStatus(error);
      sendJson(response, status, { error: status === 409 ? 'delivery_collision' : 'delivery_failed' });
    }
  });
}
