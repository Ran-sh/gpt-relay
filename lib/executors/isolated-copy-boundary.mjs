import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { matchesManagedScope, normalizeManagedPath } from '../path-policy.mjs';

function portable(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function digest(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function manifest(root) {
  const entries = new Map();
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const relative = portable(path.relative(root, absolute));
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        entries.set(relative, { type: 'symlink' });
      } else if (stat.isDirectory()) {
        visit(absolute);
      } else if (stat.isFile()) {
        entries.set(relative, { type: 'file', digest: digest(absolute) });
      }
    }
  };
  visit(root);
  return entries;
}

function changedPaths(before, after) {
  const changed = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(name);
    const right = after.get(name);
    if (!left || !right || left.type !== right.type || left.digest !== right.digest) changed.push(name);
  }
  return changed.sort();
}

function isWithin(relativePath, scopes) {
  return scopes.some((scope) => matchesManagedScope(relativePath, normalizeManagedPath(scope, { allowGlob: true })));
}

export class IsolatedCopyWorkspaceBoundary {
  async prepare({ task, cwd }) {
    const sourceRoot = path.resolve(cwd);
    const container = mkdtempSync(path.join(tmpdir(), 'gpt-relay-boundary-'));
    const isolatedRoot = path.join(container, 'workspace');
    const isolatedHome = path.join(container, 'home');
    mkdirSync(isolatedHome, { recursive: true });
    cpSync(sourceRoot, isolatedRoot, {
      recursive: true,
      filter(source) {
        const relative = portable(path.relative(sourceRoot, source));
        if (!relative) return true;
        if (relative === '.git' || relative.startsWith('.git/')) return false;
        if (relative === '.gpt-relay' || relative.startsWith('.gpt-relay/')) return false;
        return !lstatSync(source).isSymbolicLink();
      }
    });
    const baseline = manifest(isolatedRoot);
    let finalized = false;

    return {
      cwd: isolatedRoot,
      environment: {
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        SSH_AUTH_SOCK: '',
        DOCKER_CONFIG: path.join(isolatedHome, '.docker'),
        KUBECONFIG: path.join(isolatedHome, '.kube', 'config')
      },
      async finalize({ success }) {
        if (finalized) throw new Error('workspace boundary already finalized');
        finalized = true;
        const applied = [];
        const discarded = [];
        try {
          const current = manifest(isolatedRoot);
          for (const relative of changedPaths(baseline, current)) {
            const allowed = isWithin(relative, task.delegated_scope.allowed_changes ?? []);
            const forbidden = isWithin(relative, task.delegated_scope.forbidden_changes ?? []);
            const entry = current.get(relative);
            if (!success || !allowed || forbidden || entry?.type === 'symlink') {
              discarded.push(relative);
              continue;
            }
            const destination = path.resolve(sourceRoot, ...relative.split('/'));
            if (!destination.startsWith(`${sourceRoot}${path.sep}`)) {
              discarded.push(relative);
              continue;
            }
            if (!entry) {
              if (task.authorization?.destructive_operations === true) {
                rmSync(destination, { force: true });
                applied.push(relative);
              } else {
                discarded.push(relative);
              }
              continue;
            }
            mkdirSync(path.dirname(destination), { recursive: true });
            copyFileSync(path.join(isolatedRoot, ...relative.split('/')), destination);
            applied.push(relative);
          }
          return { applied, discarded };
        } finally {
          rmSync(container, { recursive: true, force: true });
        }
      }
    };
  }
}
