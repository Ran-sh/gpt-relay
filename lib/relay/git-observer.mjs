import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function revisionOf(head, status) {
  return createHash('sha256').update(head).update('\0').update(status).digest('hex');
}

function changedFiles(status) {
  return status.split('\0').filter(Boolean).map((entry) => entry.slice(3)).sort();
}

export class GitObserver {
  #store;
  #pipeline;

  constructor({ store, pipeline }) {
    if (!store || !pipeline) throw new Error('GitObserver requires store and pipeline');
    this.#store = store;
    this.#pipeline = pipeline;
  }

  async scanOnce(repository, context) {
    const root = path.resolve(repository);
    const options = { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 };
    const [{ stdout: headOutput }, { stdout: status }] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], options),
      execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], options)
    ]);
    const head = headOutput.trim();
    const revision = revisionOf(head, status);
    const cursorSource = `git:${root}`;
    if (this.#store.getCursor(cursorSource) === revision) return null;
    const result = await this.#pipeline.accept({
      event_id: `E-git-${revision.slice(0, 26)}`,
      idempotency_key: `${cursorSource}:${revision}`,
      source: 'git',
      type: 'git.changed',
      payload: {
        repository: root,
        head,
        dirty: status.length > 0,
        changed_files: changedFiles(status),
        revision
      }
    }, { ...context, source: 'git' });
    this.#store.setCursor(cursorSource, revision);
    return result;
  }
}
