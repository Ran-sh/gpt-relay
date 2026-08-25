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

function boundedInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), maximum) : fallback;
}

function eventCursor(event) {
  return String(event?.cursor ?? event?.sequence ?? event?.event_id ?? '');
}

function afterCursor(events, cursor) {
  if (!cursor) return events;
  const numericCursor = Number(cursor);
  if (Number.isFinite(numericCursor) && events.every((event) => Number.isFinite(Number(eventCursor(event))))) {
    return events.filter((event) => Number(eventCursor(event)) > numericCursor);
  }
  const found = events.findIndex((event) => eventCursor(event) === String(cursor));
  return found >= 0 ? events.slice(found + 1) : events;
}

function isLoopback(host) {
  const normalized = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function safeEventName(value) {
  return String(value ?? 'message').replace(/[^\w.-]/g, '_');
}

export class RuntimeWatchServer {
  #store;
  #host;
  #port;
  #maxEvents;
  #heartbeatMs;
  #pollMs;
  #maxClients;
  #server;
  #clients = new Set();

  constructor(store, {
    host = '127.0.0.1',
    port = 0,
    maxEvents = 500,
    heartbeatMs = 15_000,
    pollMs = 1_000,
    maxClients = 32,
    allowRemote = false
  } = {}) {
    if (!store) throw new Error('RuntimeWatchServer requires store');
    if (!isLoopback(host) && allowRemote !== true) {
      throw new Error('remote watch binding requires explicit allowRemote authorization');
    }
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('invalid watch server port');
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 10_000) throw new Error('invalid maxEvents');
    if (!Number.isInteger(heartbeatMs) || heartbeatMs < 10) throw new Error('invalid heartbeatMs');
    if (!Number.isInteger(pollMs) || pollMs < 5) throw new Error('invalid pollMs');
    if (!Number.isInteger(maxClients) || maxClients < 1 || maxClients > 10_000) throw new Error('invalid maxClients');
    this.#store = store;
    this.#host = host;
    this.#port = port;
    this.#maxEvents = maxEvents;
    this.#heartbeatMs = heartbeatMs;
    this.#pollMs = pollMs;
    this.#maxClients = maxClients;
  }

  get clientCount() {
    return this.#clients.size;
  }

  async listen() {
    if (this.#server) throw new Error('watch server is already listening');
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch(() => {
        if (!response.headersSent) writeJson(response, 500, { error: 'internal_error' });
        else response.end();
      });
    });
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
    for (const client of [...this.#clients]) client.close();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  async #queryEvents(workflowRunId, { after, limit = 100 } = {}) {
    const query = { workflowRunId, afterCursor: after, limit };
    let events;
    if (typeof this.#store.listEventsAfter === 'function') {
      events = await this.#store.listEventsAfter(query);
    } else if (typeof this.#store.listEvents === 'function') {
      events = await this.#store.listEvents(query);
      events = afterCursor(events, after);
    } else {
      events = [];
    }
    if (!Array.isArray(events)) throw new Error('watch event query must return an array');
    return events.slice(0, limit);
  }

  async #aggregate(workflowRunId) {
    const workflow = typeof this.#store.getWorkflow === 'function'
      ? await this.#store.getWorkflow(workflowRunId)
      : (await this.#store.listWorkflows()).find((item) => item.run_id === workflowRunId);
    if (!workflow) return null;
    const attempts = typeof this.#store.listAttempts === 'function'
      ? await this.#store.listAttempts({ workflowRunId })
      : [];
    const allAttention = typeof this.#store.listAttention === 'function'
      ? await this.#store.listAttention({ openOnly: false })
      : [];
    const attention = allAttention.filter((item) => item.workflow_run_id === workflowRunId);
    const events = await this.#queryEvents(workflowRunId, { limit: this.#maxEvents });
    const nodes = typeof this.#store.listWorkflowNodes === 'function'
      ? await this.#store.listWorkflowNodes(workflowRunId)
      : [];
    return { workflow, attempts, attention, events, nodes };
  }

  async #handle(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      request.resume();
      writeJson(response, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' });
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/events/stream') {
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
        response.end();
        return;
      }
      await this.#stream(request, response, url);
      return;
    }

    let body;
    let status = 200;
    if (url.pathname === '/health') {
      body = { ok: true, service: 'gpt-relay-watch', clients: this.clientCount };
    } else if (url.pathname === '/workflows') {
      body = { workflows: await this.#store.listWorkflows() };
    } else {
      const eventsMatch = url.pathname.match(/^\/workflows\/([^/]+)\/events$/);
      const workflowMatch = url.pathname.match(/^\/workflows\/([^/]+)$/);
      if (eventsMatch) {
        const workflowRunId = decodeURIComponent(eventsMatch[1]);
        const limit = boundedInteger(url.searchParams.get('limit'), 100, this.#maxEvents);
        const after = url.searchParams.get('after') ?? request.headers['last-event-id'];
        const events = await this.#queryEvents(workflowRunId, { after, limit });
        body = { events, next_cursor: events.length > 0 ? eventCursor(events.at(-1)) : String(after ?? '') };
      } else if (workflowMatch) {
        body = await this.#aggregate(decodeURIComponent(workflowMatch[1]));
        if (!body) {
          status = 404;
          body = { error: 'workflow_not_found' };
        }
      } else {
        status = 404;
        body = { error: 'not_found' };
      }
    }
    if (request.method === 'HEAD') {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end();
      return;
    }
    writeJson(response, status, body);
  }

  async #stream(request, response, url) {
    if (this.#clients.size >= this.#maxClients) {
      writeJson(response, 503, { error: 'sse_client_limit' }, { 'retry-after': '1' });
      return;
    }
    const workflowRunId = url.searchParams.get('workflow_run_id') ?? undefined;
    let cursor = request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '';
    let polling = false;
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    response.flushHeaders?.();

    const poll = async () => {
      if (polling || response.destroyed) return;
      polling = true;
      try {
        const events = await this.#queryEvents(workflowRunId, { after: cursor, limit: this.#maxEvents });
        for (const event of events) {
          const next = eventCursor(event);
          if (!next || next === cursor) continue;
          response.write(`id: ${next}\nevent: ${safeEventName(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
          cursor = next;
        }
      } finally {
        polling = false;
      }
    };
    const pollTimer = setInterval(() => void poll(), this.#pollMs);
    const heartbeatTimer = setInterval(() => {
      if (!response.destroyed) response.write(`: heartbeat ${Date.now()}\n\n`);
    }, this.#heartbeatMs);
    pollTimer.unref?.();
    heartbeatTimer.unref?.();
    const client = {
      close: () => {
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
        this.#clients.delete(client);
        if (!response.destroyed && !response.writableEnded) response.end();
      }
    };
    this.#clients.add(client);
    request.once('close', client.close);
    response.once('close', client.close);
    await poll();
  }
}
