import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
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

function sameEntry(left, right) {
  if (!left || !right) return left === right;
  return left.type === right.type && left.digest === right.digest;
}

function containsWorkspaceSecret(relativePath) {
  const lower = portable(relativePath).toLowerCase();
  const base = path.posix.basename(lower);
  const segments = lower.split('/');
  return base === '.npmrc'
    || base === '.pypirc'
    || base === '.netrc'
    || base === '.git-credentials'
    || base === 'credentials'
    || base === 'service-account.json'
    || base.startsWith('.env')
    || /\.(?:pem|key|p12|pfx)$/.test(base)
    || segments.includes('.ssh')
    || segments.includes('.aws')
    || (segments.includes('.config') && segments.includes('gcloud'));
}

function destinationIsSafe(sourceRoot, relativePath) {
  const destination = path.resolve(sourceRoot, ...relativePath.split('/'));
  if (!destination.startsWith(`${sourceRoot}${path.sep}`)) return false;
  const trustedRoot = realpathSync.native(sourceRoot);
  let cursor = sourceRoot;
  for (const segment of relativePath.split('/')) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      return false;
    }
    if (stat.isSymbolicLink()) return false;
    const resolved = realpathSync.native(cursor);
    if (resolved !== trustedRoot && !resolved.startsWith(`${trustedRoot}${path.sep}`)) return false;
  }
  return true;
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
    const sourceBaseline = manifest(sourceRoot);
    const credentialsDenied = task.authorization?.credentials !== true;
    cpSync(sourceRoot, isolatedRoot, {
      recursive: true,
      filter(source) {
        const relative = portable(path.relative(sourceRoot, source));
        if (!relative) return true;
        if (relative === '.git' || relative.startsWith('.git/')) return false;
        if (relative === '.gpt-relay' || relative.startsWith('.gpt-relay/')) return false;
        if (credentialsDenied && containsWorkspaceSecret(relative)) return false;
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
          const currentSource = manifest(sourceRoot);
          const candidates = [];
          for (const relative of changedPaths(baseline, current)) {
            const allowed = isWithin(relative, task.delegated_scope.allowed_changes ?? []);
            const forbidden = isWithin(relative, task.delegated_scope.forbidden_changes ?? []);
            const entry = current.get(relative);
            if (!success || !allowed || forbidden || entry?.type === 'symlink' || !destinationIsSafe(sourceRoot, relative)) {
              discarded.push(relative);
              continue;
            }
            if (!sameEntry(sourceBaseline.get(relative), currentSource.get(relative))) {
              throw new Error(`source changed concurrently: ${relative}`);
            }
            const destination = path.resolve(sourceRoot, ...relative.split('/'));
            if (!entry) {
              if (task.authorization?.destructive_operations === true) {
                candidates.push({ relative, destination, delete: true });
              } else {
                discarded.push(relative);
              }
              continue;
            }
            candidates.push({
              relative,
              destination,
              source: path.join(isolatedRoot, ...relative.split('/'))
            });
          }

          const backups = new Map();
          try {
            for (const candidate of candidates) {
              if (!destinationIsSafe(sourceRoot, candidate.relative)) {
                throw new Error(`destination became unsafe: ${candidate.relative}`);
              }
              const latestSource = manifest(sourceRoot);
              if (!sameEntry(sourceBaseline.get(candidate.relative), latestSource.get(candidate.relative))) {
                throw new Error(`source changed concurrently: ${candidate.relative}`);
              }
              backups.set(candidate.relative, existsSync(candidate.destination)
                ? readFileSync(candidate.destination)
                : null);
              if (candidate.delete) rmSync(candidate.destination, { force: true });
              else {
                mkdirSync(path.dirname(candidate.destination), { recursive: true });
                if (!destinationIsSafe(sourceRoot, candidate.relative)) {
                  throw new Error(`destination became unsafe: ${candidate.relative}`);
                }
                const staged = `${candidate.destination}.gpt-relay-stage-${process.pid}`;
                copyFileSync(candidate.source, staged, 1);
                try {
                  if (!destinationIsSafe(sourceRoot, candidate.relative)) {
                    throw new Error(`destination became unsafe: ${candidate.relative}`);
                  }
                  if (existsSync(candidate.destination)) rmSync(candidate.destination, { force: true });
                  renameSync(staged, candidate.destination);
                } finally {
                  rmSync(staged, { force: true });
                }
              }
              applied.push(candidate.relative);
            }
          } catch (error) {
            for (const candidate of candidates) {
              if (!backups.has(candidate.relative)) continue;
              if (!destinationIsSafe(sourceRoot, candidate.relative)) continue;
              const backup = backups.get(candidate.relative);
              if (backup === null) rmSync(candidate.destination, { force: true });
              else {
                mkdirSync(path.dirname(candidate.destination), { recursive: true });
                const staged = `${candidate.destination}.gpt-relay-rollback-${process.pid}`;
                writeFileSync(staged, backup, { flag: 'wx' });
                try {
                  if (!destinationIsSafe(sourceRoot, candidate.relative)) continue;
                  if (existsSync(candidate.destination)) rmSync(candidate.destination, { force: true });
                  renameSync(staged, candidate.destination);
                } finally {
                  rmSync(staged, { force: true });
                }
              }
            }
            throw error;
          }
          return { applied, discarded };
        } finally {
          rmSync(container, { recursive: true, force: true });
        }
      }
    };
  }
}
