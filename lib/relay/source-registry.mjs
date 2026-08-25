import { realpathSync } from 'node:fs';
import path from 'node:path';

import { GitObserver } from './git-observer.mjs';
import { FileContractObserver } from './observer.mjs';

function withinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export class SourceRegistry {
  #store;
  #pipeline;
  #workspaceRoot;

  constructor({ store, pipeline, workspaceRoot = process.cwd() }) {
    if (!store || !pipeline) throw new Error('SourceRegistry requires store and pipeline');
    this.#store = store;
    this.#pipeline = pipeline;
    this.#workspaceRoot = realpathSync(path.resolve(workspaceRoot));
  }

  #resolveConfiguredPath(configuredPath) {
    if (typeof configuredPath !== 'string' || configuredPath.length === 0) {
      throw new Error('source config.path is required');
    }
    const absolute = path.resolve(this.#workspaceRoot, configuredPath);
    if (!withinRoot(this.#workspaceRoot, absolute)) throw new Error(`source path is outside workspace root: ${configuredPath}`);
    let canonical;
    try {
      canonical = realpathSync(absolute);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      canonical = absolute;
    }
    if (!withinRoot(this.#workspaceRoot, canonical)) throw new Error(`source path is outside workspace root: ${configuredPath}`);
    return canonical;
  }

  buildEnabled(context = {}) {
    return this.#store.listSourceConfigs({ enabledOnly: true })
      .filter((source) => ['file', 'git'].includes(source.type))
      .map((source) => {
      const target = this.#resolveConfiguredPath(source.config.path);
      if (source.type === 'file') {
        const observer = new FileContractObserver({ store: this.#store, pipeline: this.#pipeline });
        return { source_id: source.source_id, type: source.type, observer, scanOnce: () => observer.scanOnce(target) };
      }
      if (source.type === 'git') {
        const observer = new GitObserver({ store: this.#store, pipeline: this.#pipeline });
        return {
          source_id: source.source_id, type: source.type, observer,
          scanOnce: () => observer.scanOnce(target, { ...context, ...(source.config.context ?? {}) })
        };
      }
      throw new Error(`unsupported source type: ${source.type}`);
      });
  }
}
