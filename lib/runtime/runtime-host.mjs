import { ObserverService } from '../relay/observer-service.mjs';

export class RuntimeHost {
  #store;
  #sourceRegistry;
  #scheduleEngine;
  #runtimeService;
  #notifier;
  #closed = false;

  constructor({ store, sourceRegistry = null, scheduleEngine = null, runtimeService, notifier = null }) {
    if (!store || !runtimeService || typeof runtimeService.runOnce !== 'function') {
      throw new Error('RuntimeHost requires store and runtimeService');
    }
    this.#store = store;
    this.#sourceRegistry = sourceRegistry;
    this.#scheduleEngine = scheduleEngine;
    this.#runtimeService = runtimeService;
    this.#notifier = notifier;
  }

  async runOnce() {
    if (this.#closed) throw new Error('runtime host is closed');
    let sources = { scanned: 0, changed: 0, errors: [] };
    if (this.#sourceRegistry) {
      let observers;
      if (typeof this.#sourceRegistry.buildEnabled === 'function') {
        observers = this.#sourceRegistry.buildEnabled().map((source) => ({
          ...source,
          id: source.id ?? source.source_id
        }));
      } else {
        await this.#sourceRegistry.refresh();
        observers = this.#sourceRegistry.observers();
      }
      sources = await new ObserverService({ observers }).scanOnce();
    }

    const occurrences = this.#scheduleEngine?.tick() ?? [];
    let schedulesEnqueued = 0;
    for (const occurrence of occurrences) {
      if (this.#store.enqueueJob({
        job_id: `J-schedule-${occurrence.occurrence_id}`,
        workflow_run_id: `W-schedule-${occurrence.schedule_id}`,
        type: 'scheduled.task',
        payload: { occurrence_id: occurrence.occurrence_id, task: occurrence.task }
      })) schedulesEnqueued += 1;
    }

    const runtime = await this.#runtimeService.runOnce();
    let notificationsEnqueued = 0;
    let notifications = { delivered: 0, failed: 0 };
    if (this.#notifier) {
      for (const attention of this.#store.listAttention({ openOnly: true })) {
        notificationsEnqueued += this.#notifier.enqueue(attention);
      }
      notifications = await this.#notifier.drain();
    }
    return {
      sources,
      schedules: { due: occurrences.length, enqueued: schedulesEnqueued },
      runtime,
      notifications: { enqueued: notificationsEnqueued, ...notifications }
    };
  }

  async start({ signal, pollMs = 1_000 } = {}) {
    while (!this.#closed && !signal?.aborted) {
      await this.runOnce();
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.max(25, pollMs));
        signal?.addEventListener('abort', finish, { once: true });
      });
    }
  }

  close() {
    if (this.#closed) return;
    this.#runtimeService.close?.();
    this.#closed = true;
  }
}
