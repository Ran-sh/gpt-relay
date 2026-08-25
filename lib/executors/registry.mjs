export class ExecutorRegistry {
  #entries = [];

  register(adapter, { priority = 0 } = {}) {
    if (!adapter || typeof adapter.id !== 'string' || adapter.id.length === 0) {
      throw new Error('executor adapter requires an id');
    }
    if (this.#entries.some((entry) => entry.adapter.id === adapter.id)) {
      throw new Error(`executor already registered: ${adapter.id}`);
    }
    this.#entries.push({ adapter, priority });
    this.#entries.sort((left, right) => right.priority - left.priority || left.adapter.id.localeCompare(right.adapter.id));
    return adapter;
  }

  entries() {
    return this.#entries.map((entry) => ({ ...entry }));
  }

  async match(requiredCapabilities) {
    const required = new Set(requiredCapabilities);
    const diagnostics = [];
    for (const entry of this.#entries) {
      let readiness;
      let capabilities;
      try {
        [readiness, capabilities] = await Promise.all([
          entry.adapter.detect(),
          entry.adapter.capabilities()
        ]);
      } catch (error) {
        diagnostics.push({ executor_id: entry.adapter.id, ready: false, reason: error.message });
        continue;
      }
      const available = new Set(capabilities);
      const missing = [...required].filter((capability) => !available.has(capability));
      diagnostics.push({
        executor_id: entry.adapter.id,
        ready: readiness.ready === true,
        reason: readiness.reason ?? null,
        missing
      });
      if (readiness.ready === true && missing.length === 0) {
        return { adapter: entry.adapter, readiness, capabilities, diagnostics };
      }
    }
    return { adapter: null, readiness: null, capabilities: [], diagnostics };
  }
}
