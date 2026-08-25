import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assertValidTaskVNext } from '../contracts/v2.mjs';

function revisionOf(content) {
  return createHash('sha256').update(content).digest('hex');
}

export class FileContractObserver {
  #store;
  #pipeline;

  constructor({ store, pipeline }) {
    if (!store || !pipeline) throw new Error('FileContractObserver requires store and pipeline');
    this.#store = store;
    this.#pipeline = pipeline;
  }

  async scanOnce(file) {
    const absolute = path.resolve(file);
    let content;
    try {
      content = await readFile(absolute, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    const revision = revisionOf(content);
    const cursorSource = `file:${absolute}`;
    if (this.#store.getCursor(cursorSource) === revision) return null;

    let contract;
    try {
      contract = JSON.parse(content);
    } catch (error) {
      throw new Error(`invalid JSON contract at ${absolute}: ${error.message}`);
    }
    assertValidTaskVNext(contract);

    const attempt = Number.isInteger(contract.metadata?.attempt) ? contract.metadata.attempt : 1;
    const result = await this.#pipeline.accept({
      event_id: `E-file-${revision.slice(0, 26)}`,
      source: 'filesystem',
      type: attempt > 1 ? 'task.resumed' : 'task.created',
      timestamp: new Date().toISOString(),
      idempotency_key: `${cursorSource}:${revision}`,
      payload: {
        path: absolute,
        revision,
        task_id: contract.id,
        attempt
      }
    }, {
      workflow_run_id: `W-${contract.id}`,
      task_id: contract.id,
      attempt_id: attempt > 0 ? `${contract.id}-attempt-${attempt}` : null,
      source: 'filesystem'
    });

    this.#store.setCursor(cursorSource, revision);
    return result;
  }
}
