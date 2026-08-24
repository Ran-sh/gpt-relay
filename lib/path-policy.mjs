import path from 'node:path';
import fs from 'node:fs';

const GLOB_RE = /[*?[\]{}]/;
const UNSUPPORTED_GLOB_RE = /[?[\]{}]/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SHELL_META_RE = /[;&|$()`%^!<>]/;
const WINDOWS_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export function normalizeManagedPath(value, { allowGlob = false, requiredPrefix } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`unsafe managed path: ${String(value)}`);
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`unsafe managed path: ${value}`);
  }

  const portable = value.replaceAll('\\', '/');
  const segments = portable.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`unsafe managed path: ${value}`);
  }
  if (segments.some((segment) => CONTROL_RE.test(segment)
    || SHELL_META_RE.test(segment)
    || segment.includes(':')
    || /[. ]$/.test(segment)
    || WINDOWS_RESERVED_RE.test(segment))) {
    throw new Error(`unsafe managed path: ${value}`);
  }
  if (segments.some((segment) => segment.includes('**') && segment !== '**')) {
    throw new Error(`unsafe managed path (** must be a complete segment): ${value}`);
  }
  if (!allowGlob && GLOB_RE.test(portable)) {
    throw new Error(`unsafe managed path: ${value}`);
  }
  if (allowGlob && UNSUPPORTED_GLOB_RE.test(portable)) {
    throw new Error(`unsafe managed path (only * and ** globs are supported): ${value}`);
  }

  const normalized = segments.join('/');
  if (requiredPrefix) {
    const prefix = normalizeManagedPath(requiredPrefix);
    if (!normalized.startsWith(`${prefix}/`)) {
      throw new Error(`managed path must be under ${prefix}/: ${value}`);
    }
  }
  return normalized;
}

export function matchesManagedScope(file, scope) {
  const normalizedFile = normalizeManagedPath(file);
  const normalizedScope = normalizeManagedPath(scope, { allowGlob: true });
  const escaped = normalizedScope.replace(/[.+^$()|\\]/g, '\\$&');
  const pattern = escaped
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('\0', '.*');
  return new RegExp(`^${pattern}$`).test(normalizedFile);
}

export function resolveManagedPath(root, relativePath) {
  const normalized = normalizeManagedPath(relativePath);
  const absoluteRoot = path.resolve(root);
  const rootStat = fs.lstatSync(absoluteRoot);
  if (rootStat.isSymbolicLink()) throw new Error(`managed root must not be a symbolic link or junction: ${absoluteRoot}`);
  const realRoot = fs.realpathSync(absoluteRoot);
  let current = realRoot;

  for (const segment of normalized.split('/')) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`managed path crosses a symbolic link or junction: ${relativePath}`);
    const realCurrent = fs.realpathSync(current);
    const relative = path.relative(realRoot, realCurrent);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`managed path escapes target root: ${relativePath}`);
    }
  }
  return path.join(realRoot, ...normalized.split('/'));
}
