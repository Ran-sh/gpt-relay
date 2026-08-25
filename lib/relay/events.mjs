import { createHash } from 'node:crypto';

const TYPE_MAP = Object.freeze({
  'thread.started': 'session.created',
  'thread.resumed': 'session.resumed',
  'thread.exited': 'session.lost',
  'turn.started': 'executor.started',
  'turn.completed': 'executor.completed',
  'turn.failed': 'executor.failed',
  'turn.cancelled': 'executor.failed',
  'item.started': 'executor.progress',
  'item.updated': 'executor.progress',
  'item.completed': 'executor.progress',
  'request.opened': 'approval.requested',
  'result.created': 'result.created'
});

const CONTROL_TYPES = new Set([
  'workflow.created', 'workflow.completed', 'workflow.failed',
  'task.created', 'task.delegated', 'task.resumed',
  'executor.started', 'executor.completed', 'executor.failed',
  'session.created', 'session.resumed', 'session.lost',
  'result.created', 'result.validated', 'result.rejected',
  'approval.requested', 'human.input_required', 'human.replied',
  'approval.granted', 'approval.denied',
  'github.ci_failed', 'github.pr_updated', 'capability.became_ready'
]);

const SECRET_KEY_RE = /(?:api[_-]?key|token|secret|password|authorization|cookie|credential|session[_-]?ref)/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[^\s"']+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[opusr]_[A-Za-z0-9_]{20,}/g
];

function redactString(value) {
  return SECRET_VALUE_PATTERNS.reduce((result, pattern) => result.replace(pattern, '[REDACTED]'), value);
}

export function redactSecrets(value, key = '') {
  if (key === 'authorization' && value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      typeof child === 'boolean' ? child : redactSecrets(child, childKey)
    ]));
  }
  if (SECRET_KEY_RE.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactSecrets(child, childKey)]));
  }
  return value;
}

function stableId(parts) {
  return createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 26);
}

export function isControlEvent(type) {
  return CONTROL_TYPES.has(type);
}

export function normalizeExecutorEvent(raw, context = {}, { now = () => new Date().toISOString() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('executor event must be an object');
  const nativeType = raw.type ?? raw.method ?? raw.event;
  if (typeof nativeType !== 'string' || nativeType.length === 0) throw new Error('executor event type is required');

  const source = context.source ?? raw.source ?? 'unknown';
  const sessionId = context.session_id ?? raw.session_id ?? raw.thread_id ?? null;
  const workflowRunId = context.workflow_run_id ?? raw.workflow_run_id;
  const attemptId = context.attempt_id ?? raw.attempt_id ?? null;
  const generation = context.generation ?? raw.generation ?? null;
  const explicitNativeId = raw.event_id ?? raw.eventId ?? raw.id ?? raw.cursor ?? context.source_cursor;
  const nativeId = explicitNativeId ?? stableId([
    source,
    context.workflow_run_id ?? '',
    context.attempt_id ?? '',
    String(raw.generation ?? context.generation ?? ''),
    nativeType,
    JSON.stringify(raw.payload ?? raw.data ?? raw)
  ]);
  const eventId = raw.event_id ?? `E-${stableId([
    source,
    workflowRunId ?? '',
    attemptId ?? '',
    String(generation ?? ''),
    sessionId ?? '',
    String(nativeId)
  ])}`;
  const type = TYPE_MAP[nativeType] ?? nativeType;
  const payloadSource = raw.payload ?? raw.data ?? Object.fromEntries(
    Object.entries(raw).filter(([key]) => ![
      'event_id', 'eventId', 'id', 'type', 'method', 'event', 'source', 'timestamp',
      'at', 'workflow_run_id', 'task_id', 'attempt_id', 'idempotency_key',
      'session_id', 'thread_id', 'generation'
    ].includes(key))
  );
  const payload = redactSecrets(payloadSource);
  const idempotencyKey = raw.idempotency_key
    ?? `${source}:${workflowRunId ?? 'no-workflow'}:${attemptId ?? 'no-attempt'}:${generation ?? 'no-generation'}:${sessionId ?? 'no-session'}:${String(nativeId)}`;

  return {
    event_id: eventId,
    workflow_run_id: workflowRunId,
    task_id: raw.task_id ?? context.task_id ?? null,
    attempt_id: attemptId,
    source,
    type,
    timestamp: raw.timestamp ?? raw.at ?? now(),
    payload,
    idempotency_key: idempotencyKey,
    lane: isControlEvent(type) ? 'control' : 'trace',
    session_id: sessionId,
    generation
  };
}
