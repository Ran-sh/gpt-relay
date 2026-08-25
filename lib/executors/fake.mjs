import { randomUUID } from 'node:crypto';

export class FakeExecutor {
  id = 'fake';

  #config;
  #handles = new Map();
  #scenarios;
  #scenarioIndex = 0;
  #statistics = { starts: 0, resumes: 0, cancels: 0 };

  constructor({ ready = true, reason = null, capabilities = [], events = [], result = { status: 'PASS' }, scenarios } = {}) {
    this.#config = {
      ready,
      reason,
      capabilities: [...capabilities],
      events: events.map((event) => structuredClone(event)),
      result: structuredClone(result)
    };
    this.#scenarios = Array.isArray(scenarios) && scenarios.length > 0
      ? scenarios.map((scenario) => structuredClone(scenario))
      : [this.#config];
  }

  async detect() {
    return { ready: this.#config.ready, reason: this.#config.ready ? null : this.#config.reason };
  }

  async capabilities() {
    return [...this.#config.capabilities];
  }

  async start(task, context = {}) {
    this.#statistics.starts += 1;
    return this.#begin(task, context, null);
  }

  async resume(session, task, context = {}) {
    this.#statistics.resumes += 1;
    return this.#begin(task, context, session.session_id);
  }

  #begin(task, context, sessionId) {
    const scenario = this.#scenarios[Math.min(this.#scenarioIndex, this.#scenarios.length - 1)];
    this.#scenarioIndex += 1;
    const handle = {
      id: `fake-${randomUUID()}`,
      executor_id: this.id,
      task_id: task.id,
      attempt_id: context.attempt_id ?? null,
      expected_session_id: sessionId,
      cancelled: false
    };
    this.#handles.set(handle.id, { handle, scenario });
    return structuredClone(handle);
  }

  async *events(handle) {
    const active = this.#handles.get(handle.id);
    if (!active) throw new Error(`unknown execution handle: ${handle.id}`);
    for (const event of active.scenario.events ?? []) {
      if (active.handle.cancelled) break;
      yield structuredClone(event);
    }
  }

  async cancel(handle) {
    const active = this.#handles.get(handle.id);
    if (!active) return false;
    this.#statistics.cancels += 1;
    active.handle.cancelled = true;
    return true;
  }

  async collectResult(handle) {
    const active = this.#handles.get(handle.id);
    if (!active) throw new Error(`unknown execution handle: ${handle.id}`);
    return structuredClone(active.scenario.result ?? this.#config.result);
  }

  stats() {
    return { ...this.#statistics };
  }
}
