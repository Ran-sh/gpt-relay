#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import pathModule from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { matchesManagedScope, normalizeManagedPath, resolveManagedPath } from '../lib/path-policy.mjs';

const STATUSES = new Set(['PASS', 'FAIL', 'PARTIAL', 'SKIP', 'BLOCKED', 'NOT RUN']);
const MODES = new Set(['IMPLEMENT', 'TEST_ONLY', 'REVIEW_ONLY']);
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
const TASK_KEYS = new Set([
  'id', 'mode', 'source_branch', 'source_commit', 'objective', 'context',
  'allowed_changes', 'forbidden_changes', 'validation', 'acceptance_criteria',
  'result_contract', 'completion_commit_contract', 'delete_active_task_on_completion', 'metadata'
]);
const RESULT_KEYS = new Set([
  'schema_version', 'task_id', 'source_commit', 'result_commit', 'status', 'summary', 'timeline',
  'changed_files', 'tests', 'blockers', 'result_path', 'result_validation', 'notes'
]);
const TEST_KEYS = new Set(['name', 'status', 'evidence']);
const TIMELINE_KEYS = new Set(['started_at', 'completed_at']);
const RESULT_VALIDATION_KEYS = new Set(['status', 'validator', 'validated_at', 'evidence']);
const ACTIVE_TASK_JSON = 'docs/agent-tasks/ACTIVE_TASK.json';
const ACTIVE_TASK_MD = 'docs/agent-tasks/ACTIVE_TASK.md';

function fail(message) {
  console.error(`INVALID: ${message}`);
  process.exitCode = 1;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPrimitive(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function validateString(value, name, errors, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') errors.push(`${name} must be a string`);
  else if (!allowEmpty && value.length === 0) errors.push(`${name} must not be empty`);
}

function validateStringArray(value, name, errors, { min = 0 } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${name} must be an array`);
    return;
  }
  if (value.length < min) errors.push(`${name} must contain at least ${min} item(s)`);
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.length === 0) errors.push(`${name}[${index}] must be a non-empty string`);
  }
  if (new Set(value).size !== value.length) errors.push(`${name} must not contain duplicates`);
}

function validateTimestamp(value, name, errors) {
  validateString(value, name, errors);
  if (typeof value !== 'string') return;
  if (!TIMESTAMP_RE.test(value)) {
    errors.push(`${name} must use second-precision ISO 8601 with timezone, for example 2026-08-21T15:12:04+08:00`);
    return;
  }
  if (Number.isNaN(Date.parse(value))) errors.push(`${name} must be a valid timestamp`);
}

function timestampMs(value) {
  return typeof value === 'string' && TIMESTAMP_RE.test(value) ? Date.parse(value) : Number.NaN;
}

function validateTask(value) {
  const errors = [];
  if (!isObject(value)) return ['task must be an object'];

  for (const key of unknownKeys(value, TASK_KEYS)) errors.push(`unknown task property: ${key}`);

  validateString(value.id, 'id', errors);
  validateString(value.mode, 'mode', errors);
  if (typeof value.mode === 'string' && !MODES.has(value.mode)) errors.push(`invalid mode: ${value.mode}`);
  validateString(value.source_branch, 'source_branch', errors);
  validateString(value.source_commit, 'source_commit', errors);
  validateString(value.objective, 'objective', errors);
  validateString(value.context, 'context', errors, { allowEmpty: true });
  validateStringArray(value.allowed_changes, 'allowed_changes', errors);
  validateStringArray(value.forbidden_changes, 'forbidden_changes', errors, { min: 1 });
  validateStringArray(value.validation, 'validation', errors, { min: 1 });
  validateStringArray(value.acceptance_criteria, 'acceptance_criteria', errors, { min: 1 });
  validateString(value.result_contract, 'result_contract', errors);
  validateStringArray(value.completion_commit_contract, 'completion_commit_contract', errors);

  for (const [name, items] of [
    ['allowed_changes', value.allowed_changes],
    ['completion_commit_contract', value.completion_commit_contract]
  ]) {
    for (const [index, item] of (items ?? []).entries()) {
      if (typeof item !== 'string') continue;
      try {
        normalizeManagedPath(item, { allowGlob: true });
      } catch (error) {
        errors.push(`${name}[${index}]: ${error.message}`);
      }
    }
  }

  if (typeof value.result_contract === 'string' && !/^docs\/agent-results\//.test(value.result_contract)) {
    errors.push(`result_contract must be under docs/agent-results/**: ${value.result_contract}`);
  }
  if (typeof value.result_contract === 'string') {
    try {
      normalizeManagedPath(value.result_contract, { requiredPrefix: 'docs/agent-results' });
    } catch (error) {
      errors.push(`result_contract: ${error.message}`);
    }
  }

  if (Array.isArray(value.allowed_changes) && typeof value.result_contract === 'string' && !value.allowed_changes.includes(value.result_contract)) {
    errors.push('allowed_changes must include result_contract');
  }

  if (Array.isArray(value.completion_commit_contract) && typeof value.result_contract === 'string') {
    if (!value.completion_commit_contract.includes(value.result_contract)) {
      errors.push('completion_commit_contract must include result_contract');
    }
    if (!value.completion_commit_contract.includes(ACTIVE_TASK_JSON)) {
      errors.push(`completion_commit_contract must include ${ACTIVE_TASK_JSON}`);
    }
  }

  if (value.delete_active_task_on_completion !== true) errors.push('delete_active_task_on_completion must be true');

  if (value.metadata !== undefined) {
    if (!isObject(value.metadata)) errors.push('metadata must be an object');
    else {
      for (const [key, item] of Object.entries(value.metadata)) {
        if (!isPrimitive(item)) errors.push(`metadata.${key} must be string, number, boolean, or null`);
      }
      if (value.metadata.companion === true && Array.isArray(value.completion_commit_contract) && !value.completion_commit_contract.includes(ACTIVE_TASK_MD)) {
        errors.push(`metadata.companion=true requires ${ACTIVE_TASK_MD} in completion_commit_contract`);
      }
    }
  }

  if (value.mode === 'TEST_ONLY' || value.mode === 'REVIEW_ONLY') {
    for (const item of value.allowed_changes ?? []) {
      if (typeof item === 'string' && !/^docs\/agent-results\//.test(item)) {
        errors.push(`${value.mode} allowed_changes may only include docs/agent-results/**: ${item}`);
      }
    }
    for (const item of value.completion_commit_contract ?? []) {
      if (typeof item === 'string' && !/^docs\/agent-results\//.test(item) && item !== ACTIVE_TASK_JSON && item !== ACTIVE_TASK_MD) {
        errors.push(`${value.mode} completion_commit_contract may only include result paths and ACTIVE task deletion: ${item}`);
      }
    }
  }

  return errors;
}

function validateResult(value, { allowMissingResultValidation = false } = {}) {
  const errors = [];
  if (!isObject(value)) return ['result must be an object'];

  for (const key of unknownKeys(value, RESULT_KEYS)) errors.push(`unknown result property: ${key}`);

  const schemaVersion = value.schema_version ?? 1;
  if (value.schema_version !== undefined && value.schema_version !== 2) {
    errors.push('schema_version must be 2 when present; omit it only for legacy Result Contract v1');
  }

  validateString(value.task_id, 'task_id', errors);
  validateString(value.source_commit, 'source_commit', errors);
  if (value.result_commit !== undefined && value.result_commit !== null) validateString(value.result_commit, 'result_commit', errors);
  validateString(value.status, 'status', errors);
  if (typeof value.status === 'string' && !STATUSES.has(value.status)) errors.push(`invalid status: ${value.status}`);
  if (value.summary !== undefined) validateString(value.summary, 'summary', errors, { allowEmpty: true });

  const requiresV2Evidence = schemaVersion === 2;
  if (requiresV2Evidence || value.timeline !== undefined) {
    if (!isObject(value.timeline)) {
      errors.push('timeline must be an object for Result Contract v2');
    } else {
      for (const key of unknownKeys(value.timeline, TIMELINE_KEYS)) errors.push(`timeline: unknown property: ${key}`);
      validateTimestamp(value.timeline.started_at, 'timeline.started_at', errors);
      validateTimestamp(value.timeline.completed_at, 'timeline.completed_at', errors);
      const started = timestampMs(value.timeline.started_at);
      const completed = timestampMs(value.timeline.completed_at);
      if (!Number.isNaN(started) && !Number.isNaN(completed) && completed < started) {
        errors.push('timeline.completed_at must not be earlier than timeline.started_at');
      }
    }
  }

  validateStringArray(value.changed_files, 'changed_files', errors);
  validateStringArray(value.blockers, 'blockers', errors);
  validateString(value.result_path, 'result_path', errors);
  if (typeof value.result_path === 'string' && !/^docs\/agent-results\//.test(value.result_path)) {
    errors.push(`result_path must be under docs/agent-results/**: ${value.result_path}`);
  }
  if (typeof value.result_path === 'string') {
    try {
      normalizeManagedPath(value.result_path, { requiredPrefix: 'docs/agent-results' });
    } catch (error) {
      errors.push(`result_path: ${error.message}`);
    }
  }
  if (value.notes !== undefined) validateStringArray(value.notes, 'notes', errors);

  if (!Array.isArray(value.tests)) errors.push('tests must be an array');
  else {
    for (const [index, test] of value.tests.entries()) {
      if (!isObject(test)) {
        errors.push(`tests[${index}] must be an object`);
        continue;
      }
      for (const key of unknownKeys(test, TEST_KEYS)) errors.push(`tests[${index}]: unknown property: ${key}`);
      validateString(test.name, `tests[${index}].name`, errors);
      validateString(test.status, `tests[${index}].status`, errors);
      if (typeof test.status === 'string' && !STATUSES.has(test.status)) errors.push(`tests[${index}]: invalid status: ${test.status}`);
      if (test.evidence !== undefined) validateString(test.evidence, `tests[${index}].evidence`, errors, { allowEmpty: true });
    }
  }

  if (requiresV2Evidence && value.result_validation === undefined && allowMissingResultValidation) {
    // --stamp validates the v2 draft first, then writes validator-owned evidence and validates again.
  } else if (requiresV2Evidence && !isObject(value.result_validation)) {
    errors.push('result_validation must be an object for Result Contract v2; run the result validator with --stamp to create it');
  } else if (value.result_validation !== undefined) {
    if (!isObject(value.result_validation)) {
      errors.push('result_validation must be an object');
    } else {
      for (const key of unknownKeys(value.result_validation, RESULT_VALIDATION_KEYS)) {
        errors.push(`result_validation: unknown property: ${key}`);
      }
      if (value.result_validation.status !== 'PASS') errors.push('result_validation.status must be PASS');
      validateString(value.result_validation.validator, 'result_validation.validator', errors);
      validateTimestamp(value.result_validation.validated_at, 'result_validation.validated_at', errors);
      validateString(value.result_validation.evidence, 'result_validation.evidence', errors);

      const completed = timestampMs(value.timeline?.completed_at);
      const validated = timestampMs(value.result_validation.validated_at);
      if (!Number.isNaN(completed) && !Number.isNaN(validated) && validated < completed) {
        errors.push('result_validation.validated_at must not be earlier than timeline.completed_at');
      }
    }
  }

  if (value.status === 'BLOCKED' && Array.isArray(value.blockers) && value.blockers.length === 0) {
    errors.push('BLOCKED result must include at least one blocker');
  }
  if (value.status === 'PASS' && Array.isArray(value.tests) && value.tests.some((test) => !isObject(test) || test.status !== 'PASS')) {
    errors.push('PASS result cannot contain non-PASS test states');
  }

  return errors;
}

function secondPrecisionNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function stampResult(path, value) {
  value.schema_version = 2;
  const draftErrors = validateResult(value, { allowMissingResultValidation: true });
  if (draftErrors.length > 0) return draftErrors;

  const validatedAt = secondPrecisionNow();
  const canonicalCommand = `node .agent-workflow/validator/validate-contract.mjs result ${value.result_path} --stamp`;
  value.result_validation = {
    status: 'PASS',
    validator: canonicalCommand,
    validated_at: validatedAt,
    evidence: `Exit 0: VALID RESULT CONTRACT: ${value.result_path}`
  };

  const finalErrors = validateResult(value);
  if (finalErrors.length > 0) return finalErrors;

  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  console.log(`VALID RESULT CONTRACT: ${path}`);
  console.log(`STAMPED RESULT VALIDATION: ${validatedAt}`);
  return [];
}

function parseHandoffOptions(args) {
  const options = { target: process.cwd(), json: false };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--json') {
      options.json = true;
    } else if (['--task', '--result', '--target'].includes(option) && args[index + 1]) {
      options[option.slice(2)] = args[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown or incomplete handoff option: ${option}`);
    }
  }
  if (!options.task || !options.result) throw new Error('handoff requires --task and --result');
  return options;
}

function gitChangedPaths(target, sourceCommit) {
  const commands = [
    ['diff', '--name-only', '-z', `${sourceCommit}..HEAD`],
    ['diff', '--name-only', '-z'],
    ['diff', '--cached', '--name-only', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z']
  ];
  const changed = new Set();
  for (const args of commands) {
    const result = spawnSync('git', ['-C', target, ...args], { encoding: 'utf8' });
    if (result.status !== 0) return null;
    for (const file of result.stdout.split('\0').filter(Boolean)) {
      changed.add(normalizeManagedPath(file.replaceAll('\\', '/')));
    }
  }
  return [...changed].sort();
}

async function validateHandoff(options) {
  const target = pathModule.resolve(options.target);
  const canonicalTask = resolveManagedPath(target, ACTIVE_TASK_JSON);
  if (pathModule.resolve(options.task) !== canonicalTask) {
    return { valid: false, errors: [`task must be the canonical ${ACTIVE_TASK_JSON}`] };
  }
  const task = JSON.parse(await readFile(canonicalTask, 'utf8'));
  const canonicalResult = resolveManagedPath(target, task.result_contract);
  if (pathModule.resolve(options.result) !== canonicalResult) {
    return { valid: false, errors: ['result file must match the canonical task.result_contract path'] };
  }
  const result = JSON.parse(await readFile(canonicalResult, 'utf8'));
  const errors = [
    ...validateTask(task).map((error) => `task: ${error}`),
    ...validateResult(result).map((error) => `result: ${error}`)
  ];

  if (result.task_id !== task.id) errors.push(`task_id must match task.id (${task.id})`);
  if (result.result_path !== task.result_contract) {
    errors.push(`result_path must match task.result_contract (${task.result_contract})`);
  }
  if (task.source_commit === 'LATEST') {
    const resolved = spawnSync('git', ['-C', target, 'rev-parse', task.source_branch], { encoding: 'utf8' });
    const expected = resolved.status === 0 ? resolved.stdout.trim() : null;
    if (!expected || result.source_commit !== expected) {
      errors.push(`source_commit must be the exact resolved SHA for ${task.source_branch}@LATEST${expected ? ` (${expected})` : ''}`);
    }
  } else if (result.source_commit !== task.source_commit) {
    errors.push(`source_commit must match task.source_commit (${task.source_commit})`);
  }

  try {
    const relativeResult = pathModule.relative(target, pathModule.resolve(options.result)).replaceAll('\\', '/');
    const actualResult = normalizeManagedPath(relativeResult);
    if (actualResult !== result.result_path) {
      errors.push(`result_path does not identify the supplied result file (${actualResult})`);
    }
  } catch (error) {
    errors.push(`result_path: ${error.message}`);
  }

  for (const [index, changed] of (result.changed_files ?? []).entries()) {
    try {
      const normalized = normalizeManagedPath(changed);
      if (!(task.completion_commit_contract ?? []).some((scope) => matchesManagedScope(normalized, scope))) {
        errors.push(`changed_files[${index}] is outside completion_commit_contract: ${changed}`);
      }
      const completionOnly = normalized === ACTIVE_TASK_JSON || normalized === ACTIVE_TASK_MD;
      if (!completionOnly && !(task.allowed_changes ?? []).some((scope) => matchesManagedScope(normalized, scope))) {
        errors.push(`changed_files[${index}] is outside allowed_changes: ${changed}`);
      }
    } catch (error) {
      errors.push(`changed_files[${index}]: ${error.message}`);
    }
  }
  if (!(result.changed_files ?? []).includes(result.result_path)) {
    errors.push('changed_files must include result_path');
  }
  const actualChanges = gitChangedPaths(target, result.source_commit);
  if (actualChanges === null) {
    errors.push(`cannot resolve actual Git changes from source_commit: ${result.source_commit}`);
  } else {
    let reportedChanges = [];
    try {
      reportedChanges = [...new Set((result.changed_files ?? []).map((file) => normalizeManagedPath(file)))].sort();
    } catch {
      // Individual changed_files diagnostics above are more specific.
    }
    if (JSON.stringify(actualChanges) !== JSON.stringify(reportedChanges)) {
      errors.push(`changed_files must exactly match actual Git changes (actual: ${actualChanges.join(', ') || '(none)'})`);
    }
  }
  if (result.status === 'PASS' && (result.blockers ?? []).length > 0) {
    errors.push('PASS result must not contain blockers');
  }

  return { valid: errors.length === 0, errors };
}

async function main() {
  const [kind, path, ...options] = process.argv.slice(2);
  if (kind === 'handoff') {
    try {
      const handoffOptions = parseHandoffOptions(process.argv.slice(3));
      const report = await validateHandoff(handoffOptions);
      if (handoffOptions.json) console.log(JSON.stringify(report, null, 2));
      if (!report.valid) {
        for (const error of report.errors) fail(error);
      } else if (!handoffOptions.json) {
        console.log(`VALID HANDOFF: ${handoffOptions.task} -> ${handoffOptions.result}`);
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (!['task', 'result'].includes(kind) || !path) {
    console.error('Usage: node validator/validate-contract.mjs <task|result> <path-to-json> [--stamp] | handoff --task <file> --result <file> [--target <dir>] [--json]');
    process.exit(2);
  }

  const unknownOptions = options.filter((option) => option !== '--stamp');
  if (unknownOptions.length > 0) {
    console.error(`Unknown option(s): ${unknownOptions.join(', ')}`);
    process.exit(2);
  }
  const stamp = options.includes('--stamp');
  if (stamp && kind !== 'result') {
    console.error('--stamp is supported only for result validation');
    process.exit(2);
  }

  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    fail(`cannot read/parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (kind === 'result' && stamp) {
    const errors = await stampResult(path, value);
    if (errors.length > 0) {
      for (const error of errors) fail(error);
    }
    return;
  }

  const errors = kind === 'task' ? validateTask(value) : validateResult(value);
  if (errors.length > 0) {
    for (const error of errors) fail(error);
    return;
  }

  console.log(`VALID ${kind.toUpperCase()} CONTRACT: ${path}`);
}

await main();
