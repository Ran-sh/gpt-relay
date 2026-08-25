import { randomUUID } from 'node:crypto';

export class RuntimeService {
  #store;
  #ownerId;
  #leaseName;
  #leaseTtlMs;
  #pipeline;
  #processSupervisor;
  #onJob;
  #closed = false;

  constructor({
    store,
    ownerId = `service-${randomUUID()}`,
    leaseName = 'gpt-relay',
    leaseTtlMs = 30_000,
    pipeline,
    processSupervisor,
    onJob = async () => ({})
  }) {
    if (!store || !pipeline || typeof onJob !== 'function') {
      throw new Error('RuntimeService requires store, pipeline, and onJob');
    }
    this.#store = store;
    this.#ownerId = ownerId;
    this.#leaseName = leaseName;
    this.#leaseTtlMs = leaseTtlMs;
    this.#pipeline = pipeline;
    this.#processSupervisor = processSupervisor;
    this.#onJob = onJob;
    if (!store.acquireLease({
      name: leaseName,
      owner_id: ownerId,
      pid: process.pid,
      ttl_ms: leaseTtlMs
    })) {
      throw new Error(`runtime service lease is already held: ${leaseName}`);
    }
  }

  async runOnce() {
    if (this.#closed) throw new Error('runtime service is closed');
    if (!this.#store.renewLease({
      name: this.#leaseName,
      owner_id: this.#ownerId,
      ttl_ms: this.#leaseTtlMs
    })) throw new Error('runtime service lease was lost');

    const reconciliation = this.#processSupervisor
      ? await this.#processSupervisor.reconcile()
      : { alive: [], lost: [] };
    let controlRouted = 0;
    let controlFailed = 0;
    for (const workflow of this.#store.listWorkflows().reverse()) {
      const drained = await this.#pipeline.drainPending({ workflowRunId: workflow.run_id });
      controlRouted += drained.routed;
      controlFailed += drained.failed;
      if (drained.failed > 0) break;
    }

    let jobsCompleted = 0;
    let jobsFailed = 0;
    const pending = this.#store.listJobs({ status: 'PENDING', limit: 1 })[0];
    if (pending) {
      const job = this.#store.claimJob(pending.job_id, this.#ownerId);
      if (job) {
        try {
          const result = await this.#onJob(job);
          this.#store.completeJob(job.job_id, result);
          jobsCompleted += 1;
        } catch (error) {
          this.#store.failJob(job.job_id, error instanceof Error ? error.message : String(error));
          jobsFailed += 1;
        }
      }
    }
    return {
      reconciliation,
      control_routed: controlRouted,
      control_failed: controlFailed,
      jobs_completed: jobsCompleted,
      jobs_failed: jobsFailed
    };
  }

  async start({ signal, pollMs = 1_000 } = {}) {
    while (!this.#closed && !signal?.aborted) {
      await this.runOnce();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.max(25, pollMs));
        timer.unref?.();
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }

  close() {
    if (this.#closed) return;
    this.#store.requeueRunningJobs(this.#ownerId);
    this.#store.releaseLease({ name: this.#leaseName, owner_id: this.#ownerId });
    this.#closed = true;
  }
}
