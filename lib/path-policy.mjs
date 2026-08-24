import path from 'node:path';

const GLOB_RE = /[*?[\]{}]/;

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
  if (!allowGlob && GLOB_RE.test(portable)) {
    throw new Error(`unsafe managed path: ${value}`);
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
    .replaceAll('?', '[^/]')
    .replaceAll('\0', '.*');
  return new RegExp(`^${pattern}$`).test(normalizedFile);
}
