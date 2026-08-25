import { matchesManagedScope, normalizeManagedPath } from '../path-policy.mjs';
import { isManagedResultPath } from './result.mjs';

export const AUTHORIZATION_KEYS = Object.freeze([
  'shell',
  'network',
  'browser_login',
  'credentials',
  'git_commit',
  'git_push',
  'publish',
  'deploy_production',
  'destructive_operations'
]);

const ACTION_AUTHORIZATION = Object.freeze({
  'local.shell': 'shell',
  network: 'network',
  'browser.login': 'browser_login',
  credentials: 'credentials',
  'git.commit': 'git_commit',
  'git.push': 'git_push',
  publish: 'publish',
  'deploy.production': 'deploy_production',
  'destructive.operations': 'destructive_operations'
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateString(value, name, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${name} must be a non-empty string`);
  }
}

function validateStringArray(value, name, errors, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${name} must be an array`);
    return;
  }
  if (!allowEmpty && value.length === 0) errors.push(`${name} must not be empty`);
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push(`${name}[${index}] must be a non-empty string`);
    }
  }
  if (new Set(value).size !== value.length) errors.push(`${name} must not contain duplicates`);
}

function validateScopes(scopes, name, errors) {
  validateStringArray(scopes, name, errors);
  if (!Array.isArray(scopes)) return;
  for (const [index, scope] of scopes.entries()) {
    if (typeof scope !== 'string') continue;
    try {
      normalizeManagedPath(scope, { allowGlob: true });
    } catch (error) {
      errors.push(`${name}[${index}]: ${error.message}`);
    }
  }
}

function scopeContains(parent, child) {
  if (parent === child) return true;
  const normalizedParent = normalizeManagedPath(parent, { allowGlob: true });
  const normalizedChild = normalizeManagedPath(child, { allowGlob: true });
  if (!/[*?\[\]{}]/.test(normalizedChild)) {
    return matchesManagedScope(normalizedChild, normalizedParent);
  }
  if (normalizedParent.endsWith('/**')) {
    return normalizedChild.startsWith(normalizedParent.slice(0, -2));
  }
  return false;
}

export function validateTaskVNext(task) {
  const errors = [];
  if (!isObject(task)) return ['task must be an object'];

  validateString(task.id, 'id', errors);
  validateString(task.objective, 'objective', errors);
  validateStringArray(task.required_capabilities, 'required_capabilities', errors);
  validateScopes(task.allowed_changes, 'allowed_changes', errors);
  validateStringArray(task.forbidden_changes, 'forbidden_changes', errors, { allowEmpty: false });

  if (!isObject(task.delegated_scope)) {
    errors.push('delegated_scope must be an object');
  } else {
    const scope = task.delegated_scope;
    validateString(scope.objective, 'delegated_scope.objective', errors);
    validateStringArray(scope.required_capabilities, 'delegated_scope.required_capabilities', errors, { allowEmpty: false });
    validateScopes(scope.allowed_changes, 'delegated_scope.allowed_changes', errors);
    validateStringArray(scope.forbidden_changes, 'delegated_scope.forbidden_changes', errors, { allowEmpty: false });
    validateStringArray(scope.return, 'delegated_scope.return', errors, { allowEmpty: false });

    if (Array.isArray(scope.required_capabilities) && Array.isArray(task.required_capabilities)) {
      for (const capability of scope.required_capabilities) {
        if (!task.required_capabilities.includes(capability)) {
          errors.push(`delegated capability ${capability} is outside task required_capabilities`);
        }
      }
    }

    if (Array.isArray(scope.allowed_changes) && Array.isArray(task.allowed_changes)) {
      for (const delegatedPath of scope.allowed_changes) {
        if (typeof delegatedPath !== 'string') continue;
        let contained = false;
        try {
          contained = task.allowed_changes.some((parentPath) => (
            typeof parentPath === 'string' && scopeContains(parentPath, delegatedPath)
          ));
        } catch {
          contained = false;
        }
        if (!contained) errors.push(`delegated path ${delegatedPath} is outside task allowed_changes`);
      }
    }

    if (Array.isArray(scope.forbidden_changes) && Array.isArray(task.forbidden_changes)) {
      for (const parentForbidden of task.forbidden_changes) {
        if (typeof parentForbidden !== 'string') continue;
        let preserved = false;
        try {
          preserved = scope.forbidden_changes.some((delegatedForbidden) => (
            typeof delegatedForbidden === 'string' && scopeContains(delegatedForbidden, parentForbidden)
          ));
        } catch {
          preserved = false;
        }
        if (!preserved) errors.push(`delegated scope must preserve forbidden path ${parentForbidden}`);
      }
    }

    if (Array.isArray(scope.allowed_changes) && Array.isArray(scope.forbidden_changes)) {
      for (const allowedPath of scope.allowed_changes) {
        if (typeof allowedPath !== 'string') continue;
        for (const forbiddenPath of scope.forbidden_changes) {
          if (typeof forbiddenPath !== 'string') continue;
          try {
            if (scopeContains(forbiddenPath, allowedPath) || scopeContains(allowedPath, forbiddenPath)) {
              errors.push(`delegated allowed path ${allowedPath} overlaps forbidden path ${forbiddenPath}`);
            }
          } catch {
            // Individual path validation already reports malformed patterns.
          }
        }
      }
    }
  }

  if (!isObject(task.authorization)) {
    errors.push('authorization must be an object');
  } else {
    for (const key of AUTHORIZATION_KEYS) {
      if (typeof task.authorization[key] !== 'boolean') {
        errors.push(`authorization.${key} must be boolean`);
      }
    }
  }

  if (task.result_contract !== undefined && !isManagedResultPath(task.result_contract)) {
    errors.push('result_contract must be inside docs/agent-results/**');
  }

  return errors;
}

export function assertValidTaskVNext(task) {
  const errors = validateTaskVNext(task);
  if (errors.length > 0) throw new Error(`Invalid Task Contract vNext:\n- ${errors.join('\n- ')}`);
  return task;
}

export function assertAuthorized(task, actions) {
  if (!isObject(task?.authorization)) throw new Error('authorization is missing');
  for (const action of actions) {
    const key = ACTION_AUTHORIZATION[action] ?? action.replaceAll('.', '_');
    if (!AUTHORIZATION_KEYS.includes(key)) throw new Error(`unknown authorization action: ${action}`);
    if (task.authorization[key] !== true) throw new Error(`authorization denies ${key}`);
  }
  return true;
}
