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
    return this.#store.claimRemoteRunnerJob(
      runnerId,
      new Date(this.#now().getTime() + ttlMs).toISOString()
    );
  }

  heartbeat(jobId, runnerId, { ttlMs = 30_000 } = {}) {
    return this.#store.heartbeatRemoteRunnerJob(
      jobId,
      runnerId,
      new Date(this.#now().getTime() + ttlMs).toISOString()
    );
  }

  submit({ runner_job_id, runner_id, token, generation, result }) {
    const job = this.#store.getRemoteRunnerJob(runner_job_id);
    if (!job) throw new Error(`unknown runner job: ${runner_job_id}`);
    if (job.status === 'COMPLETED') throw new Error(`runner job ${runner_job_id} is already completed`);
    if (job.status !== 'LEASED' || job.runner_id !== runner_id || job.token !== token) {
      throw new Error('runner lease or result token is invalid');
    }
    if (job.generation !== generation) throw new Error(`runner generation mismatch: expected ${job.generation}`);
    return this.#store.completeRemoteRunnerJob(runner_job_id, result);
  }
}
