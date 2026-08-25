import { randomUUID } from 'node:crypto';

export class RemoteRunnerQueue {
  #store;
  #id;
  #now;

  constructor(store, { idFactory = randomUUID, now = () => new Date() } = {}) {
    if (!store) throw new Error('RemoteRunnerQueue requires store');
    this.#store = store;
    this.#id = idFactory;
    this.#now = now;
  }

  dispatch(job) {
    this.#store.saveRemoteRunnerJob({ ...job, token: this.#id() });
    return this.#store.getRemoteRunnerJob(job.runner_job_id);
  }

  claim(runnerId, { ttlMs = 30_000 } = {}) {
    const now = this.#now();
    return this.#store.claimRemoteRunnerJob(
      runnerId,
      new Date(now.getTime() + ttlMs).toISOString(),
      now.toISOString(),
      this.#id()
    );
  }

  heartbeat(jobId, runnerId, { ttlMs = 30_000 } = {}) {
    const job = this.#store.getRemoteRunnerJob(jobId);
    const now = this.#now();
    if (job?.status !== 'LEASED' || job.runner_id !== runnerId
      || Date.parse(job.lease_expires_at) <= now.getTime()) return false;
    return this.#store.heartbeatRemoteRunnerJob(
      jobId,
      runnerId,
      new Date(now.getTime() + ttlMs).toISOString(),
      { token: job.token, generation: job.generation, now: now.toISOString() }
    );
  }

  submit({ runner_job_id, runner_id, token, generation, result }) {
    const job = this.#store.getRemoteRunnerJob(runner_job_id);
    if (!job) throw new Error(`unknown runner job: ${runner_job_id}`);
    if (job.status === 'COMPLETED') throw new Error(`runner job ${runner_job_id} is already completed`);
    if (job.status === 'LEASED' && Date.parse(job.lease_expires_at) <= this.#now().getTime()) {
      throw new Error(`runner lease for ${runner_job_id} has expired`);
    }
    if (job.status !== 'LEASED' || job.runner_id !== runner_id || job.token !== token) {
      throw new Error('runner lease or result token is invalid');
    }
    if (job.generation !== generation) throw new Error(`runner generation mismatch: expected ${job.generation}`);
    const completed = this.#store.completeRemoteRunnerJob(runner_job_id, result, {
      runner_id, token, generation, now: this.#now().toISOString()
    });
    if (!completed) throw new Error('runner lease changed before result completion');
    return completed;
  }
}
