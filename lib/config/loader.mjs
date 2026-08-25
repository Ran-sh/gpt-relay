import { readFileSync } from 'node:fs';

import { matchesManagedScope, normalizeManagedPath } from '../path-policy.mjs';

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function containsScope(parent, child) {
  const normalizedParent = normalizeManagedPath(parent, { allowGlob: true });
  const normalizedChild = normalizeManagedPath(child, { allowGlob: true });
  if (normalizedParent === normalizedChild) return true;
  if (!/[*?\[\]{}]/.test(normalizedChild)) return matchesManagedScope(normalizedChild, normalizedParent);
  return normalizedParent.endsWith('/**') && normalizedChild.startsWith(normalizedParent.slice(0, -2));
}

function resolveScopes(layers) {
  let effective;
  for (const layer of layers) {
    if (layer.allowed_changes === undefined) continue;
    if (!Array.isArray(layer.allowed_changes)) throw new Error('allowed_changes must be an array');
    for (const scope of layer.allowed_changes) normalizeManagedPath(scope, { allowGlob: true });
    if (effective) {
      for (const child of layer.allowed_changes) {
        if (!effective.some((parent) => containsScope(parent, child))) {
          throw new Error(`configuration cannot expand task scope with ${child}`);
        }
      }
    }
    effective = [...layer.allowed_changes];
  }
  return effective ?? [];
}

function resolveAuthorization(layers) {
  const keys = new Set(layers.flatMap((layer) => Object.keys(layer.authorization ?? {})));
  return Object.fromEntries([...keys].map((key) => {
    const workspaceValue = layers[0].authorization?.[key];
    if (workspaceValue !== undefined && typeof workspaceValue !== 'boolean') {
      throw new Error(`authorization.${key} must be boolean`);
    }
    let allowed = workspaceValue === true;
    for (const layer of layers.slice(1)) {
      if (!Object.hasOwn(layer.authorization ?? {}, key)) continue;
      const value = layer.authorization[key];
      if (typeof value !== 'boolean') throw new Error(`authorization.${key} must be boolean`);
      allowed = allowed && value;
    }
    return [key, allowed];
  }));
}

function resolveBudget(layers) {
  const keys = new Set(layers.flatMap((layer) => Object.keys(layer.budget ?? {})));
  return Object.fromEntries([...keys].map((key) => {
    const values = layers.flatMap((layer) => Object.hasOwn(layer.budget ?? {}, key) ? [layer.budget[key]] : []);
    if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error(`budget.${key} must be a non-negative finite number`);
    }
    return [key, Math.min(...values)];
  }));
}

export function loadConfigFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot load config ${file}: ${error.message}`);
  }
  return object(parsed, 'config');
}

export function resolveEffectiveConfig({ workspace, workflow = {}, task = {} }) {
  const layers = [object(workspace, 'workspace config'), object(workflow, 'workflow config'), object(task, 'task config')];
  return {
    ...workspace,
    ...workflow,
    ...task,
    authorization: resolveAuthorization(layers),
    budget: resolveBudget(layers),
    allowed_changes: resolveScopes(layers)
  };
}
