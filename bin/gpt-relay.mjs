#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { validateTaskVNext } from '../lib/contracts/v2.mjs';
import { runCodexSmoke } from '../lib/doctor/codex-smoke.mjs';
import { ClaudeAdapter } from '../lib/executors/claude.mjs';
import { CodexAdapter } from '../lib/executors/codex.mjs';
import { ExecutorRegistry } from '../lib/executors/registry.mjs';
import { AuditedDecisionRunner } from '../lib/orchestrator/audited-decision-runner.mjs';
import { OpenAIDecisionProvider } from '../lib/orchestrator/openai-decision-provider.mjs';
import { FileContractObserver } from '../lib/relay/observer.mjs';
import { RelayPipeline } from '../lib/relay/pipeline.mjs';
import { WorkflowDaemon } from '../lib/runtime/daemon.mjs';
import { ProcessSupervisor } from '../lib/runtime/process-supervisor.mjs';
import { DEFAULT_PRIMARY_CAPABILITIES, createRuntimeJobHandler } from '../lib/runtime/production-runtime.mjs';
import { RuntimeService } from '../lib/runtime/service.mjs';
import { SessionRegistry } from '../lib/runtime/session-registry.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function parseOptions(args, { flags = [] } = {}) {
  const flagSet = new Set(flags);
  const options = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      options._.push(token);
      continue;
    }
    const name = token.slice(2);
    if (flagSet.has(name)) {
      options[name] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) fail(`${token} requires a value`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function databasePath(options) {
  return path.resolve(options.db ?? path.join(process.cwd(), '.gpt-relay', 'runtime.sqlite'));
}

function print(value, json, text) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(text(value));
}

function withStore(options, operation) {
  const store = new SQLiteRuntimeStore(databasePath(options));
  try {
    return operation(store);
  } finally {
    store.close();
  }
}

function runtime(command, args) {
  const options = parseOptions(args, { flags: ['json', 'control-only'] });
  if (command === 'init') {
    const report = withStore(options, () => ({ ok: true, database: databasePath(options) }));
    print(report, options.json, (value) => `Initialized ${value.database}`);
    return;
  }
  if (command === 'status') {
    const report = withStore(options, (store) => ({
      database: databasePath(options),
      workflows: store.listWorkflows(),
      open_attention: store.listAttention({ openOnly: true }).length
    }));
    print(report, options.json, (value) => (
      value.workflows.length === 0
        ? 'No workflow runs.'
        : value.workflows.map((workflow) => `${workflow.run_id} ${workflow.state} ${workflow.objective}`).join('\n')
    ));
    return;
  }
  if (command === 'attention') {
    const report = withStore(options, (store) => ({
      attention: store.listAttention({ openOnly: true })
    }));
    print(report, options.json, (value) => (
      value.attention.length === 0
        ? 'No open Attention.'
        : value.attention.map((item) => `${item.attention_id} ${item.type} ${item.message}`).join('\n')
    ));
    return;
  }
  if (command === 'events') {
    if (!options.workflow) fail('runtime events requires --workflow <run-id>');
    const report = withStore(options, (store) => ({
      events: store.listEvents({
        workflowRunId: options.workflow,
        controlOnly: options['control-only'] === true,
        limit: options.limit ? Number(options.limit) : 100
      })
    }));
    print(report, options.json, (value) => value.events
      .map((event) => `${event.timestamp} ${event.source} ${event.type}`).join('\n'));
    return;
  }
  fail(`unknown runtime command: ${command ?? '(missing)'}`);
}

function task(command, args) {
  if (command !== 'validate-vnext') fail(`unknown task command: ${command ?? '(missing)'}`);
  const options = parseOptions(args, { flags: ['json'] });
  const file = options._[0];
  if (!file) fail('task validate-vnext requires a JSON file');
  let value;
  try {
    value = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    fail(`cannot read task: ${error.message}`);
  }
  const errors = validateTaskVNext(value);
  const report = { valid: errors.length === 0, errors };
  print(report, options.json, (result) => result.valid ? 'VALID' : `INVALID\n- ${result.errors.join('\n- ')}`);
  if (!report.valid) process.exitCode = 1;
}

function operatorCommand(kind, command, args) {
  const options = parseOptions(args, { flags: ['json'] });
  const attentionId = options._[0];
  if (!attentionId) fail(`${kind} ${command} requires an Attention id`);
  const response = kind === 'human' ? options.text : options.reason ?? command;
  if (!response) fail(`${kind} ${command} requires ${kind === 'human' ? '--text' : '--reason'} <value>`);
  const responseType = kind === 'human'
    ? 'human.replied'
    : command === 'grant' ? 'approval.granted' : command === 'deny' ? 'approval.denied' : null;
  if (!responseType) fail(`unknown approval command: ${command}`);
  const report = withStore(options, (store) => {
    const attention = store.getAttention(attentionId);
    if (!attention) fail(`unknown Attention: ${attentionId}`);
    const expectedType = kind === 'human' ? 'DECISION' : 'APPROVAL';
    if (attention.type !== expectedType) fail(`Attention ${attentionId} is ${attention.type}, expected ${expectedType}`);
    return {
      attention: store.respondToAttention({
        attentionId,
        response,
        responseType,
        idempotencyKey: options['idempotency-key']
      })
    };
  });
  print(report, options.json, (value) => `${value.attention.attention_id} ${value.attention.status}`);
}

async function source(command, args) {
  if (command !== 'scan-file') fail(`unknown source command: ${command ?? '(missing)'}`);
  const options = parseOptions(args, { flags: ['json'] });
  const file = options._[0];
  if (!file) fail('source scan-file requires a task contract file');
  const store = new SQLiteRuntimeStore(databasePath(options));
  try {
    const pipeline = new RelayPipeline({
      store,
      route: async (event) => {
        if (event.type !== 'task.created' && event.type !== 'task.resumed') return;
        store.enqueueJob({
          job_id: `J-event-${event.event_id}`,
          workflow_run_id: event.workflow_run_id,
          type: event.type,
          payload: event.payload
        });
      }
    });
    const observer = new FileContractObserver({ store, pipeline });
    const result = await observer.scanOnce(path.resolve(file));
    const report = result ?? { status: 'unchanged', event: null };
    print(report, options.json, (value) => value.event ? `${value.status} ${value.event.type}` : value.status);
  } finally {
    store.close();
  }
}

async function doctor(command, args) {
  if (command !== 'codex') fail(`unknown doctor command: ${command ?? '(missing)'}`);
  const options = parseOptions(args, { flags: ['json', 'live'] });
  const adapter = new CodexAdapter({
    cli: options.cli ?? 'codex',
    cliArgs: options['cli-arg'] ? [options['cli-arg']] : []
  });
  const report = await runCodexSmoke({
    adapter,
    live: options.live === true,
    timeoutMs: options.timeout ? Number(options.timeout) : 30_000
  });
  print(report, options.json, (value) => value.ready
    ? `Codex ready${value.version ? ` (${value.version})` : ''}${value.live ? ' — live smoke passed' : ''}`
    : `Codex unavailable: ${value.reason ?? 'unknown reason'}`);
  if (!report.ready) process.exitCode = 1;
}

async function service(command, args) {
  if (!['once', 'start'].includes(command)) fail(`unknown service command: ${command ?? '(missing)'}`);
  const options = parseOptions(args, { flags: ['json'] });
  if (!process.env.OPENAI_API_KEY) fail('service requires OPENAI_API_KEY for audited workflow decisions');
  const store = new SQLiteRuntimeStore(databasePath(options));
  const sessions = new SessionRegistry(store);
  const supervisor = new ProcessSupervisor({ sessions });
  const registry = new ExecutorRegistry();
  registry.register(new CodexAdapter(), { priority: 100 });
  registry.register(new ClaudeAdapter(), { priority: 90 });
  const provider = new OpenAIDecisionProvider({
    apiKey: process.env.OPENAI_API_KEY,
    model: options.model ?? process.env.GPT_RELAY_DECISION_MODEL ?? 'gpt-5.6'
  });
  const daemon = new WorkflowDaemon({
    store,
    registry,
    decisionRunner: new AuditedDecisionRunner({ store, provider }),
    primaryCapabilities: DEFAULT_PRIMARY_CAPABILITIES,
    processSupervisor: supervisor
  });
  const pipeline = new RelayPipeline({ store });
  const runtime = new RuntimeService({
    store,
    pipeline,
    processSupervisor: supervisor,
    onJob: createRuntimeJobHandler({ store, daemon })
  });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (command === 'once') {
      const report = await runtime.runOnce();
      print(report, options.json, (value) => `jobs completed=${value.jobs_completed} failed=${value.jobs_failed}`);
    } else {
      await runtime.start({ signal: abort.signal, pollMs: options.poll ? Number(options.poll) : 1_000 });
    }
  } finally {
    runtime.close();
    store.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

function help() {
  console.log(`gpt-relay

Usage:
  gpt-relay runtime init [--db <file>] [--json]
  gpt-relay runtime status [--db <file>] [--json]
  gpt-relay runtime attention [--db <file>] [--json]
  gpt-relay runtime events --workflow <id> [--db <file>] [--control-only] [--limit <n>] [--json]
  gpt-relay human reply <attention-id> --text <value> [--db <file>] [--json]
  gpt-relay approval grant|deny <attention-id> [--reason <value>] [--db <file>] [--json]
  gpt-relay source scan-file <task.json> [--db <file>] [--json]
  gpt-relay doctor codex [--live] [--cli <file>] [--cli-arg <value>] [--json]
  gpt-relay service once|start [--db <file>] [--model <id>] [--poll <ms>] [--json]
  gpt-relay task validate-vnext <file> [--json]
  gpt-relay --version

The legacy agent-workflow command remains available for v1.x install/task/result workflows.`);
}

const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === '-v') {
  console.log(readFileSync(path.join(packageRoot, 'VERSION'), 'utf8').trim());
} else if (args[0] === 'runtime') {
  runtime(args[1], args.slice(2));
} else if (args[0] === 'task') {
  task(args[1], args.slice(2));
} else if (args[0] === 'human') {
  operatorCommand('human', args[1], args.slice(2));
} else if (args[0] === 'approval') {
  operatorCommand('approval', args[1], args.slice(2));
} else if (args[0] === 'source') {
  await source(args[1], args.slice(2));
} else if (args[0] === 'doctor') {
  await doctor(args[1], args.slice(2));
} else if (args[0] === 'service') {
  await service(args[1], args.slice(2));
} else if (['help', '--help', '-h', undefined].includes(args[0])) {
  help();
} else {
  fail(`unknown command: ${args[0]}\nRun gpt-relay --help for usage.`);
}
