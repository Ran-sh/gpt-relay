const RESULT_STATUSES = new Set(['PASS', 'FAIL', 'PARTIAL', 'SKIP', 'BLOCKED', 'NOT RUN']);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value, name, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${name} must be a non-empty string`);
  }
}

function validateStatus(value, name, errors) {
  if (!RESULT_STATUSES.has(value)) errors.push(`${name} has an invalid status`);
}

function validateTimeline(timeline, errors) {
  if (!isRecord(timeline)) {
    errors.push('timeline must be an object');
    return;
  }
  requireText(timeline.started_at, 'timeline.started_at', errors);
  requireText(timeline.completed_at, 'timeline.completed_at', errors);
  const started = Date.parse(timeline.started_at);
  const completed = Date.parse(timeline.completed_at);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) {
    errors.push('timeline timestamps must be valid ISO 8601 dates');
  } else if (started > completed) {
    errors.push('timeline.completed_at must not precede timeline.started_at');
  }
}

function validateTests(tests, errors) {
  if (!Array.isArray(tests)) {
    errors.push('tests must be an array');
    return;
  }
  for (const [index, item] of tests.entries()) {
    if (!isRecord(item)) {
      errors.push(`tests[${index}] must be an object`);
      continue;
    }
    requireText(item.name, `tests[${index}].name`, errors);
    validateStatus(item.status, `tests[${index}].status`, errors);
    if (item.evidence !== undefined && typeof item.evidence !== 'string') {
      errors.push(`tests[${index}].evidence must be a string`);
    }
  }
}

function validateTextArray(value, name, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${name} must be an array`);
    return;
  }
  for (const [index, item] of value.entries()) {
    requireText(item, `${name}[${index}]`, errors);
  }
}

function validateArtifacts(artifacts, errors) {
  if (!Array.isArray(artifacts)) {
    errors.push('artifacts must be an array');
    return;
  }
  for (const [index, artifact] of artifacts.entries()) {
    if (!isRecord(artifact)) {
      errors.push(`artifacts[${index}] must be an object`);
      continue;
    }
    requireText(artifact.path ?? artifact.artifact_ref, `artifacts[${index}].path`, errors);
    if (artifact.kind !== undefined) requireText(artifact.kind, `artifacts[${index}].kind`, errors);
    if (artifact.sha256 !== undefined && !/^[a-f\d]{64}$/i.test(artifact.sha256)) {
      errors.push(`artifacts[${index}].sha256 must be a SHA-256 digest`);
    }
  }
}

function validateEvidence(evidence, errors) {
  if (!Array.isArray(evidence)) {
    errors.push('evidence must be an array');
    return;
  }
  for (const [index, item] of evidence.entries()) {
    if (!isRecord(item)) {
      errors.push(`evidence[${index}] must be an object`);
      continue;
    }
    requireText(item.kind, `evidence[${index}].kind`, errors);
    requireText(item.summary, `evidence[${index}].summary`, errors);
    if (item.ref !== undefined) requireText(item.ref, `evidence[${index}].ref`, errors);
  }
}

export function isManagedResultPath(value) {
  if (typeof value !== 'string' || !value.startsWith('docs/agent-results/')) return false;
  if (/[\\*?\[\]{}\0]/.test(value)) return false;
  const segments = value.split('/');
  return segments.length > 2 && segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function validateRuntimeResultContract(value) {
  const errors = [];
  if (!isRecord(value)) return ['result must be an object'];
  requireText(value.task_id, 'task_id', errors);
  requireText(value.summary, 'summary', errors);
  validateStatus(value.status, 'status', errors);
  if (!isManagedResultPath(value.result_path)) {
    errors.push('result_path must be inside docs/agent-results/**');
  }
  validateTimeline(value.timeline, errors);
  validateTests(value.tests, errors);
  validateTextArray(value.blockers, 'blockers', errors);
  validateArtifacts(value.artifacts, errors);
  validateEvidence(value.evidence, errors);
  return errors;
}

export function assertRuntimeResultContract(value) {
  const errors = validateRuntimeResultContract(value);
  if (errors.length > 0) {
    throw new Error(`Invalid runtime Result Contract:\n- ${errors.join('\n- ')}`);
  }
  return value;
}
