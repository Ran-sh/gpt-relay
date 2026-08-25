import { validateTaskVNext } from './v2.mjs';

export const DECISIONS = Object.freeze([
  'DISPATCH',
  'FOLLOW_UP',
  'RETRY',
  'WAIT',
  'ASK_HUMAN',
  'REQUEST_APPROVAL',
  'PAUSE',
  'COMPLETE',
  'FAIL'
]);

const DECISION_KEYS = new Set(['decision', 'reason', 'delegated_scope']);
const SCOPE_DECISIONS = new Set(['DISPATCH', 'FOLLOW_UP']);

export function validateDecision(value, { task } = {}) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['decision must be an object'];
  for (const key of Object.keys(value)) {
    if (!DECISION_KEYS.has(key)) errors.push(`unknown decision property: ${key}`);
  }
  if (!DECISIONS.includes(value.decision)) errors.push(`unknown decision: ${value.decision}`);
  if (typeof value.reason !== 'string' || value.reason.trim().length === 0) {
    errors.push('decision.reason must be a non-empty string');
  }
  if (SCOPE_DECISIONS.has(value.decision) && !value.delegated_scope) {
    errors.push(`${value.decision} requires delegated_scope`);
  }
  if (value.delegated_scope && task) {
    const taskErrors = validateTaskVNext({ ...task, delegated_scope: value.delegated_scope });
    errors.push(...taskErrors.filter((error) => error.startsWith('delegated')));
  }
  return errors;
}

export function assertDecision(value, options) {
  const errors = validateDecision(value, options);
  if (errors.length > 0) throw new Error(`Invalid Decision Contract:\n- ${errors.join('\n- ')}`);
  return value;
}
