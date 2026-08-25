export class ObserverService {
  #observers;

  constructor({ observers = [] } = {}) {
    this.#observers = [...observers];
  }

  async scanOnce() {
    let changed = 0;
    const errors = [];
    for (const source of this.#observers) {
      try {
        if (await source.scanOnce()) changed += 1;
      } catch (error) {
        errors.push({
          source_id: source.id ?? 'unknown',
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { scanned: this.#observers.length, changed, errors };
  }

  async start({ signal, intervalMs = 1_000 } = {}) {
    while (!signal?.aborted) {
      await this.scanOnce();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.max(25, intervalMs));
        timer.unref?.();
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }
}
