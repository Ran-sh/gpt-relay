import { randomUUID } from 'node:crypto';

export class FakeExecutor {
  id = 'fake';

  #config;
  #handles = new Map();

  constructor({ ready = true, reason = null, capabilities = [], events = [], result = { status: 'PASS' } } = {}) {
    this.#config = {
      ready,
      reason,
      capabilities: [...capabilities],
      events: events.map((event) => structuredClone(event)),
      result: structuredClone(result)
    };
  }

  async detect() {
    return { ready: this.#config.ready, reason: this.#config.ready ? null : this.#config.reason };
  }

  async capabilities() {
    return [...this.#config.capabilities];
  }

  async start(task, context = {}) {
    const handle = {
      id: `fake-${randomUUID()}`,
      executor_id: this.id,
      task_id: task.id,
      attempt_id: context.attempt_id ?? null,
      cancelled: false
    };
    this.#handles.set(handle.id, handle);
    return structuredClone(handle);
  }

  async *events(handle) {
    const active = this.#handles.get(handle.id);
    if (!active) throw new Error(`unknown execution handle: ${handle.id}`);
    for (const event of this.#config.events) {
      if (active.cancelled) break;
      yield structuredClone(event);
    }
  }

  async cancel(handle) {
    const active = this.#handles.get(handle.id);
    if (!active) return false;
    active.cancelled = true;
    return true;
  }

  async collectResult(handle) {
    if (!this.#handles.has(handle.id)) throw new Error(`unknown execution handle: ${handle.id}`);
    return structuredClone(this.#config.result);
  }
}
