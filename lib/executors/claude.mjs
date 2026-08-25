import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

import { assertAuthorized, assertValidTaskVNext } from '../contracts/v2.mjs';
import { buildChildEnvironment, renderCodexPrompt } from './codex.mjs';
import { IsolatedCopyWorkspaceBoundary } from './isolated-copy-boundary.mjs';

function bounded(value, limit = 8_000) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`;
}

function requiredAuthorizationActions(task) {
  const capabilities = task.delegated_scope?.required_capabilities ?? [];
  return capabilities.filter((capability) => [
    'local.shell', 'network', 'browser.login', 'credentials', 'git.commit',
    'git.push', 'publish', 'deploy.production', 'destructive.operations'
  ].includes(capability));
}

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

export class ClaudeAdapter {
  id = 'claude';
  #config;
  #executions = new Map();

  constructor({
    cli = 'claude', cliArgs = [], environment = {}, detectTimeoutMs = 5_000,
    workspaceBoundary = new IsolatedCopyWorkspaceBoundary()
  } = {}) {
    if (workspaceBoundary && typeof workspaceBoundary.prepare !== 'function') {
      throw new TypeError('workspaceBoundary.prepare must be a function');
    }
    this.#config = { cli, cliArgs: [...cliArgs], environment: { ...environment }, detectTimeoutMs, workspaceBoundary };
  }

  async detect() {
    const result = spawnSync(this.#config.cli, [...this.#config.cliArgs, '--version'], {
      encoding: 'utf8', timeout: this.#config.detectTimeoutMs, windowsHide: true,
      env: buildChildEnvironment(null, process.env, this.#config.environment)
    });
    if (result.error) return { ready: false, reason: result.error.message, version: null };
    if (result.status !== 0) return { ready: false, reason: bounded(result.stderr), version: null };
    return { ready: true, reason: null, version: String(result.stdout).trim() || null };
  }

  async capabilities() {
    return [
      'local.shell', 'local.test', 'local.build', `platform.${process.platform}`,
      ...(process.platform === 'win32' ? ['windows'] : []),
      'session.resume', 'structured_output', 'cancel'
    ];
  }

  async start(task, context = {}) {
    return this.#launch(task, context, null);
  }

  async resume(session, task, context = {}) {
    if (!session?.session_id) throw new Error('resume requires session.session_id');
    return this.#launch(task, context, session.session_id);
  }

  async #launch(task, context, expectedSessionId) {
    assertValidTaskVNext(task);
    assertAuthorized(task, requiredAuthorizationActions(task));
    const writable = task.delegated_scope.allowed_changes.length > 0;
    if (writable && !this.#config.workspaceBoundary) {
      throw new Error('writable delegated scope requires an enforceable workspace boundary');
    }
    const requestedCwd = context.cwd ?? process.cwd();
    const boundary = this.#config.workspaceBoundary
      ? await this.#config.workspaceBoundary.prepare({ task, cwd: requestedCwd, context })
      : null;
    const cwd = boundary?.cwd ?? requestedCwd;
    const prompt = renderCodexPrompt(task, context);
    const args = [
      ...this.#config.cliArgs,
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--safe-mode',
      '--permission-mode', 'dontAsk',
      '--max-turns', '20',
      ...(expectedSessionId ? ['--resume', expectedSessionId] : [])
    ];
    const child = spawn(this.#config.cli, args, {
      cwd,
      env: buildChildEnvironment(task, process.env, {
        ...this.#config.environment,
        ...(boundary?.environment ?? {})
      }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const queue = createAsyncQueue();
    const state = {
      child, boundary, expectedSessionId, queue, terminal: null, sessionId: null,
      stderr: '', invalidLines: [], exit: null
    };
    state.done = new Promise((resolve) => { state.resolve = resolve; });
    let stdoutRemainder = '';
    const parseLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        state.invalidLines.push(bounded(trimmed, 500));
        queue.push({
          type: 'executor.failed',
          payload: { reason: 'invalid_structured_output', line: bounded(trimmed, 500) }
        });
        return;
      }
      if (message.type === 'system' && message.subtype === 'init') {
        state.sessionId = message.session_id ?? state.sessionId;
        queue.push({
          type: 'thread.started',
          thread_id: message.session_id,
          payload: { native_type: 'system.init', resumed: Boolean(expectedSessionId) }
        });
      } else if (message.type === 'result') {
        state.terminal = message;
        state.sessionId = message.session_id ?? state.sessionId;
        queue.push({
          type: message.is_error ? 'executor.failed' : 'executor.completed',
          session_id: message.session_id,
          payload: { subtype: message.subtype, cost_usd: message.total_cost_usd ?? null }
        });
      } else {
        queue.push({ type: 'executor.progress', payload: { native_type: message.type } });
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutRemainder += chunk;
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? '';
      for (const line of lines) parseLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { state.stderr = bounded(`${state.stderr}${chunk}`); });
    child.on('error', (error) => { state.stderr = bounded(`${state.stderr}\n${error.message}`); });
    child.on('close', (code, signal) => {
      if (stdoutRemainder) parseLine(stdoutRemainder);
      state.exit = { code, signal };
      queue.end();
      state.resolve();
    });
    const handle = {
      id: `claude-${randomUUID()}`, executor_id: this.id, task_id: task.id,
      args: args.slice(this.#config.cliArgs.length), pid: child.pid ?? null,
      expected_session_id: expectedSessionId
    };
    this.#executions.set(handle.id, state);
    return handle;
  }

  async *events(handle) {
    const state = this.#executions.get(handle.id);
    if (!state) throw new Error(`unknown Claude execution handle: ${handle.id}`);
    yield* state.queue;
  }

  async cancel(handle) {
    const state = this.#executions.get(handle.id);
    if (!state || state.exit) return false;
    return state.child.kill('SIGTERM');
  }

  async collectResult(handle) {
    const state = this.#executions.get(handle.id);
    if (!state) throw new Error(`unknown Claude execution handle: ${handle.id}`);
    await state.done;
    const sessionMismatch = state.expectedSessionId && state.sessionId !== state.expectedSessionId;
    const passed = !sessionMismatch && state.invalidLines.length === 0
      && state.exit.code === 0 && state.terminal?.subtype === 'success' && state.terminal?.is_error === false;
    const result = {
      status: passed ? 'PASS' : 'FAIL',
      summary: sessionMismatch
        ? `Claude resume session mismatch: expected ${state.expectedSessionId}, received ${state.sessionId ?? 'none'}`
        : ((state.terminal?.result ?? state.stderr) || 'Claude did not complete successfully'),
      exit_status: state.exit.code,
      signal: state.exit.signal,
      session_id: state.sessionId,
      session_lost: Boolean(sessionMismatch),
      total_cost_usd: state.terminal?.total_cost_usd ?? null,
      usage: state.terminal?.usage ?? null,
      stderr: state.stderr || null
    };
    await state.boundary?.finalize?.({ success: passed, result });
    return result;
  }
}
