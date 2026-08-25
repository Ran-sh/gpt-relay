import { createServer } from 'node:http';

function writeJson(response, statusCode, value, headers = {}) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  });
  response.end(JSON.stringify(value));
}

export class RuntimeWatchServer {
  #store;
  #host;
  #port;
  #maxEvents;
  #server;

  constructor(store, { host = '127.0.0.1', port = 0, maxEvents = 500 } = {}) {
    if (!store) throw new Error('RuntimeWatchServer requires store');
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('invalid watch server port');
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 10_000) throw new Error('invalid maxEvents');
    this.#store = store;
    this.#host = host;
    this.#port = port;
    this.#maxEvents = maxEvents;
  }

  async listen() {
    if (this.#server) throw new Error('watch server is already listening');
    this.#server = createServer((request, response) => this.#handle(request, response));
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#port, this.#host, resolve);
    });
    return this.#server.address();
  }

  async close() {
    if (!this.#server) return;
    const server = this.#server;
    this.#server = null;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  #handle(request, response) {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        request.resume();
        writeJson(response, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' });
        return;
      }
      const url = new URL(request.url, 'http://localhost');
      let body;
      let status = 200;
      if (url.pathname === '/health') {
        body = { ok: true, service: 'gpt-relay-watch' };
      } else if (url.pathname === '/workflows') {
        body = { workflows: this.#store.listWorkflows() };
      } else {
        const match = url.pathname.match(/^\/workflows\/([^/]+)\/events$/);
        if (!match) {
          status = 404;
          body = { error: 'not_found' };
        } else {
          const requested = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
          const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), this.#maxEvents) : 100;
          body = { events: this.#store.listEvents({ workflowRunId: decodeURIComponent(match[1]), limit }) };
        }
      }
      if (request.method === 'HEAD') {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end();
        return;
      }
      writeJson(response, status, body);
    } catch {
      writeJson(response, 500, { error: 'internal_error' });
    }
  }
}
