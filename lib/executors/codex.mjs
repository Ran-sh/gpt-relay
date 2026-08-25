import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

import { assertAuthorized, assertValidTaskVNext } from '../contracts/v2.mjs';
import { redactSecrets } from '../relay/events.mjs';

function createAsyncQueue() {
  const values = [];
  const waiters = [];
  let ended = false;

  return {
    push(value) {
      if (ended) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else values.push(value);
    },
    end() {
      if (ended) return;
      ended = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (values.length > 0) return Promise.resolve({ value: values.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        }
      };
    }
  };
}

function boundedText(value, limit = 4_000) {
  if (typeof value !== 'string') return '';
  const redacted = redactSecrets(value);
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit)}\n[truncated]`;
}

function requiredAuthorizationActions(task) {
  const capabilities = task.delegated_scope?.required_capabilities ?? [];
  return capabilities.filter((capability) => [
    'local.shell', 'network', 'browser.login', 'credentials', 'git.commit',
    'git.push', 'publish', 'deploy.production', 'destructive.operations'
  ].includes(capability));
}

const SENSITIVE_ENVIRONMENT_KEY = /(?:api[_-]?key|token|secret|password|authorization|cookie|credential|openai|anthropic|github|gitlab|aws|azure)/i;

export function buildChildEnvironment(task, parentEnvironment = process.env, overrides = {}) {
  const environment = { ...parentEnvironment, ...overrides };
  if (task?.authorization?.credentials !== true) {
    for (const key of Object.keys(environment)) {
      if (SENSITIVE_ENVIRONMENT_KEY.test(key)) delete environment[key];
    }
  }
  return environment;
}

export function renderCodexPrompt(task, context = {}) {
  assertValidTaskVNext(task);
  const scope = task.delegated_scope;
  const envelope = {
    objective: scope.objective,
    required_capabilities: scope.required_capabilities,
    allowed_changes: scope.allowed_changes,
    forbidden_changes: scope.forbidden_changes,
    validation: scope.validation ?? task.validation ?? [],
    return: scope.return,
    authorization: task.authorization
  };
  const handoff = boundedText(context.handoff);

  return [
    'Execute only the delegated capability gap below.',
    'Do not broaden the objective or infer permissions from available capabilities.',
    'Treat every false authorization flag as a hard prohibition.',
    'Return structured, observable evidence; an exit code alone is not proof of success.',
    '',
    JSON.stringify(envelope, null, 2),
    ...(handoff ? ['', 'Bounded handoff from the previous attempt:', handoff] : [])
  ].join('\n');
}

export class CodexAdapter {
  id = 'codex';

  #config;
  #executions = new Map();

  constructor({
    cli = 'codex',
    cliArgs = [],
    environment = {},
    detectTimeoutMs = 5_000,
    workspaceBoundary = null
  } = {}) {
    if (workspaceBoundary && typeof workspaceBoundary.prepare !== 'function') {
      throw new TypeError('workspaceBoundary.prepare must be a function');
    }
    this.#config = {
      cli,
      cliArgs: [...cliArgs],
      environment: { ...environment },
      detectTimeoutMs,
      workspaceBoundary
    };
  }

  async detect() {
    const result = spawnSync(
      this.#config.cli,
      [...this.#config.cliArgs, '--version'],
      {
        encoding: 'utf8',
        timeout: this.#config.detectTimeoutMs,
        windowsHide: true,
        env: buildChildEnvironment(null, process.env, this.#config.environment)
      }
    );
    if (result.error) return { ready: false, reason: result.error.message, version: null };
    if (result.status !== 0) {
      return {
        ready: false,
        reason: boundedText(result.stderr || `codex exited ${result.status}`),
        version: null
      };
    }
    return { ready: true, reason: null, version: String(result.stdout).trim() || null };
  }

  async capabilities() {
    return [
      'local.shell',
      'local.test',
      'local.build',
      `platform.${process.platform}`,
      'session.resume',
      'structured_output',
      'cancel'
    ];
  }

  async start(task, context = {}) {
    return this.#launch(task, context, null);
  }

  async resume(session, task, context = {}) {
    if (!session || typeof session.session_id !== 'string' || session.session_id.length === 0) {
      throw new Error('resume requires session.session_id');
    }
    return this.#launch(task, context, session.session_id);
  }

  async #launch(task, context, resumeSessionId) {
    assertValidTaskVNext(task);
    assertAuthorized(task, requiredAuthorizationActions(task));

    const prompt = renderCodexPrompt(task, context);
    const writable = task.delegated_scope.allowed_changes.length > 0;
    if (writable && !this.#config.workspaceBoundary) {
      throw new Error('writable delegated scope requires an enforceable workspace boundary');
    }
    const requestedCwd = context.cwd ?? process.cwd();
    const boundary = this.#config.workspaceBoundary
      ? await this.#config.workspaceBoundary.prepare({ task, cwd: requestedCwd, context })
      : null;
    const executionCwd = boundary?.cwd ?? requestedCwd;
    if (typeof executionCwd !== 'string' || executionCwd.length === 0) {
      throw new Error('workspace boundary must provide a valid cwd');
    }
    const sandbox = writable ? 'workspace-write' : 'read-only';
    const args = [
      ...this.#config.cliArgs,
      'exec',
      '--json',
      '--color', 'never',
      '--sandbox', sandbox,
      '--skip-git-repo-check',
      '-C', executionCwd,
      ...(resumeSessionId ? ['resume', resumeSessionId] : []),
      prompt
    ];
    const child = spawn(this.#config.cli, args, {
      cwd: executionCwd,
      env: buildChildEnvironment(task, process.env, this.#config.environment),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const queue = createAsyncQueue();
    const state = {
      child,
      queue,
      stderr: '',
      stdoutRemainder: '',
      invalidLines: [],
      terminal: null,
      sessionId: null,
      expectedSessionId: resumeSessionId,
      summary: '',
      usage: null,
      cancelled: false,
      exit: null,
      exitPromise: null,
      boundary
    };
    state.exitPromise = new Promise((resolve) => {
      state.resolveExit = resolve;
    });

    const parseLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        state.invalidLines.push(boundedText(trimmed, 500));
        queue.push({
          type: 'executor.failed',
          payload: { reason: 'invalid_structured_output', line: boundedText(trimmed, 500) }
        });
        return;
      }
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') state.sessionId = event.thread_id;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        state.summary = event.item.text;
      }
      if (event.type === 'turn.completed' || event.type === 'turn.failed') {
        state.terminal = event;
        state.usage = event.usage ?? null;
      }
      queue.push(event);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      state.stdoutRemainder += chunk;
      const lines = state.stdoutRemainder.split(/\r?\n/);
      state.stdoutRemainder = lines.pop() ?? '';
      for (const line of lines) parseLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      state.stderr = boundedText(`${state.stderr}${chunk}`, 8_000);
    });
    child.on('error', (error) => {
      state.stderr = boundedText(`${state.stderr}\n${error.message}`, 8_000);
    });
    child.on('close', (code, signal) => {
      if (state.stdoutRemainder) parseLine(state.stdoutRemainder);
      state.exit = { code, signal };
      if (!state.terminal && state.invalidLines.length === 0) {
        queue.push({
          type: 'executor.failed',
          payload: { reason: 'missing_terminal_event', exit_status: code, signal }
        });
      }
      queue.end();
      state.resolveExit(state.exit);
    });

    const handle = {
      id: `codex-${randomUUID()}`,
      executor_id: this.id,
      task_id: task.id,
      workflow_run_id: context.workflow_run_id ?? null,
      attempt_id: context.attempt_id ?? null,
      expected_session_id: resumeSessionId,
      args: args.slice(this.#config.cliArgs.length),
      pid: child.pid ?? null
    };
    this.#executions.set(handle.id, state);
    return handle;
  }

  async *events(handle) {
    const state = this.#executions.get(handle.id);
    if (!state) throw new Error(`unknown Codex execution handle: ${handle.id}`);
    yield* state.queue;
  }

  async cancel(handle) {
    const state = this.#executions.get(handle.id);
    if (!state || state.exit) return false;
    state.cancelled = true;
    return state.child.kill('SIGTERM');
  }

  async collectResult(handle) {
    const state = this.#executions.get(handle.id);
    if (!state) throw new Error(`unknown Codex execution handle: ${handle.id}`);
    const exit = state.exit ?? await state.exitPromise;

    if (state.expectedSessionId && state.sessionId !== state.expectedSessionId) {
      const result = {
        status: 'FAIL',
        summary: `Codex resume session mismatch: expected ${state.expectedSessionId}, received ${state.sessionId ?? 'none'}`,
        exit_status: exit.code,
        session_id: state.sessionId,
        session_lost: true,
        stderr: state.stderr || null
      };
      await state.boundary?.finalize?.({ success: false, result });
      return result;
    }
    if (state.invalidLines.length > 0) {
      const result = {
        status: 'FAIL',
        summary: `Codex produced invalid structured output (${state.invalidLines.length} line(s))`,
        exit_status: exit.code,
        session_id: state.sessionId,
        stderr: state.stderr || null
      };
      await state.boundary?.finalize?.({ success: false, result });
      return result;
    }

    const passed = state.terminal?.type === 'turn.completed' && exit.code === 0 && !state.cancelled;
    const terminalMessage = state.terminal?.error?.message;
    const result = {
      status: passed ? 'PASS' : 'FAIL',
      summary: passed
        ? state.summary || 'Codex turn completed with structured evidence.'
        : boundedText(terminalMessage || state.stderr || `Codex did not complete successfully (exit ${exit.code})`),
      exit_status: exit.code,
      signal: exit.signal,
      session_id: state.sessionId,
      usage: state.usage,
      cancelled: state.cancelled,
      stderr: state.stderr || null
    };
    await state.boundary?.finalize?.({ success: passed, result });
    return result;
  }
}
