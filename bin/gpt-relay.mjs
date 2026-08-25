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
import { createGitHubIngressServer } from '../lib/relay/github-ingress-server.mjs';
import { GitHubWebhookSource } from '../lib/relay/github-webhook.mjs';
import { RelayPipeline } from '../lib/relay/pipeline.mjs';
import { SourceRegistry } from '../lib/relay/source-registry.mjs';
import { WorkflowDaemon } from '../lib/runtime/daemon.mjs';
import { ProcessSupervisor } from '../lib/runtime/process-supervisor.mjs';
import {
  DEFAULT_PRIMARY_CAPABILITIES,
  createProductionRoute,
  createRuntimeJobHandler
} from '../lib/runtime/production-runtime.mjs';
import { RuntimeService } from '../lib/runtime/service.mjs';
import { RuntimeHost } from '../lib/runtime/runtime-host.mjs';
import { ResultContractService } from '../lib/runtime/result-contract-service.mjs';
import { ScheduleEngine } from '../lib/runtime/scheduler-service.mjs';
import { SessionRegistry } from '../lib/runtime/session-registry.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';
import { RuntimeWatchServer } from '../lib/runtime/watch-server.mjs';

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

function workflow(command, args) {
  if (command !== 'resume') fail(`unknown workflow command: ${command ?? '(missing)'}`);
  const options = parseOptions(args, { flags: ['json'] });
  const workflowRunId = options._[0];
  if (!workflowRunId) fail('workflow resume requires a workflow run id');
  const report = withStore(options, (store) => {
    const current = store.getWorkflow(workflowRunId);
    if (!current) fail(`unknown workflow: ${workflowRunId}`);
    if (current.state !== 'PAUSED') fail(`workflow ${workflowRunId} is ${current.state}, expected PAUSED`);
    const jobId = options['idempotency-key'] ?? `J-resume-${workflowRunId}`;
    store.enqueueJob({
      job_id: jobId,
      workflow_run_id: workflowRunId,
      type: 'workflow.resume_requested',
      payload: { reason: options.reason ?? 'operator resume' }
    });
    return { job: store.getJob(jobId) };
  });
  print(report, options.json, (value) => `${value.job.job_id} ${value.job.status}`);
}

async function source(command, args) {
  const options = parseOptions(args, { flags: ['json'] });
  if (command === 'list') {
    const report = withStore(options, (store) => ({ sources: store.listSourceConfigs() }));
    print(report, options.json, (value) => value.sources
      .map((item) => `${item.source_id} ${item.type} ${item.enabled ? 'enabled' : 'disabled'} r${item.revision}`).join('\n'));
    return;
  }
  if (['enable', 'disable'].includes(command)) {
    const sourceId = options._[0];
    if (!sourceId) fail(`source ${command} requires a source id`);
    const report = withStore(options, (store) => ({
      source: store.setSourceConfigEnabled(sourceId, command === 'enable')
    }));
    print(report, options.json, (value) => `${value.source.source_id} ${value.source.enabled ? 'enabled' : 'disabled'}`);
    return;
  }
  if (command === 'add-github') {
    const sourceId = options._[0];
    if (!sourceId || !options['secret-env']) {
      fail('source add-github requires <source-id> --secret-env <environment-variable>');
    }
    const report = withStore(options, (store) => ({
      source: store.upsertSourceConfig({
        source_id: sourceId,
        type: 'github',
        enabled: true,
        config: {},
        secret_env: { webhook: options['secret-env'] }
      })
    }));
    print(report, options.json, (value) => `${value.source.source_id} r${value.source.revision}`);
    return;
  }
  if (['add-file', 'add-git'].includes(command)) {
    const [sourceId, configuredPath] = options._;
    if (!sourceId || !configuredPath) fail(`source ${command} requires <source-id> <path>`);
    const report = withStore(options, (store) => ({
      source: store.upsertSourceConfig({
        source_id: sourceId,
        type: command === 'add-file' ? 'file' : 'git',
        enabled: true,
        config: { path: configuredPath }
      })
    }));
    print(report, options.json, (value) => `${value.source.source_id} r${value.source.revision}`);
    return;
  }
  if (command !== 'scan-file') fail(`unknown source command: ${command ?? '(missing)'}`);
  const file = options._[0];
  if (!file) fail('source scan-file requires a task contract file');
  const store = new SQLiteRuntimeStore(databasePath(options));
  try {
    const pipeline = new RelayPipeline({
      store,
      route: createProductionRoute(store, { workspaceRoot: options.cwd ?? process.cwd() })
    });
    const observer = new FileContractObserver({ store, pipeline });
    const result = await observer.scanOnce(path.resolve(file));
    const report = result ?? { status: 'unchanged', event: null };
    print(report, options.json, (value) => value.event ? `${value.status} ${value.event.type}` : value.status);
  } finally {
    store.close();
  }
}

async function ingress(command, args) {
  if (command !== 'github') fail(`unknown ingress command: ${command ?? '(missing)'}`);
  const options = parseOptions(args, { flags: ['json'] });
  const store = new SQLiteRuntimeStore(databasePath(options));
  const pipeline = new RelayPipeline({
    store,
    route: createProductionRoute(store, { workspaceRoot: options.cwd ?? process.cwd() })
  });
  const server = createGitHubIngressServer({
    configResolver: async (sourceId) => {
      const sourceConfig = store.getSourceConfig(sourceId);
      return sourceConfig?.type === 'github' ? sourceConfig : null;
    },
    secretResolver: async (_sourceId, sourceConfig) => process.env[sourceConfig.secret_env?.webhook],
    sourceFactory: (sourceOptions) => new GitHubWebhookSource({ ...sourceOptions, store, pipeline }),
    contextResolver: async (sourceId) => ({
      workspace_id: options.workspace ?? 'default', source_id: sourceId
    }),
    maxBytes: options['max-bytes'] ? Number(options['max-bytes']) : 1_000_000
  });
  const host = options.host ?? '127.0.0.1';
  const port = options.port ? Number(options.port) : 8788;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  print({ address }, options.json, (value) => `GitHub ingress listening on ${value.address.address}:${value.address.port}`);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await new Promise((resolve) => abort.signal.addEventListener('abort', resolve, { once: true }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function watch(command, args) {
  const options = parseOptions(args, { flags: ['json', 'allow-remote'] });
  const store = new SQLiteRuntimeStore(databasePath(options));
  if (command !== 'serve') {
    try {
      const workflow = store.getWorkflow(command);
      if (!workflow) fail(`unknown workflow: ${command ?? '(missing)'}`);
      const report = {
        workflow,
        attempts: store.listAttempts({ workflowRunId: command }),
        attention: store.listAttention({ openOnly: false }).filter((item) => item.workflow_run_id === command),
        events: store.listEvents({ workflowRunId: command, limit: options.limit ? Number(options.limit) : 100 })
      };
      print(report, options.json, (value) => `${value.workflow.run_id} ${value.workflow.state}\n${value.events.length} events`);
    } finally {
      store.close();
    }
    return;
  }
  const server = new RuntimeWatchServer(store, {
    host: options.host ?? '127.0.0.1',
    port: options.port ? Number(options.port) : 8787,
    allowRemote: options['allow-remote'] === true
  });
  const address = await server.listen();
  print({ address }, options.json, (value) => `Watch server listening on ${value.address.address}:${value.address.port}`);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await new Promise((resolve) => abort.signal.addEventListener('abort', resolve, { once: true }));
  } finally {
    await server.close();
    store.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
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
    processSupervisor: supervisor,
    resultContractService: new ResultContractService({ workspace: options.cwd ?? process.cwd() })
  });
  const pipeline = new RelayPipeline({
    store,
    route: createProductionRoute(store, { workspaceRoot: options.cwd ?? process.cwd() })
  });
  const runtime = new RuntimeService({
    store,
    pipeline,
    processSupervisor: supervisor,
    onJob: createRuntimeJobHandler({ store, daemon })
  });
  const host = new RuntimeHost({
    store,
    sourceRegistry: new SourceRegistry({
      store, pipeline, workspaceRoot: options.cwd ?? process.cwd()
    }),
    scheduleEngine: new ScheduleEngine(store),
    runtimeService: runtime
  });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (command === 'once') {
      const report = await host.runOnce();
      print(report, options.json, (value) => `jobs completed=${value.runtime.jobs_completed} failed=${value.runtime.jobs_failed}`);
    } else {
      await host.start({ signal: abort.signal, pollMs: options.poll ? Number(options.poll) : 1_000 });
    }
  } finally {
    host.close();
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
  gpt-relay workflow resume <run-id> [--reason <value>] [--db <file>] [--json]
  gpt-relay source scan-file <task.json> [--cwd <workspace>] [--db <file>] [--json]
  gpt-relay source add-file|add-git <source-id> <path> [--db <file>] [--json]
  gpt-relay source add-github <source-id> --secret-env <name> [--db <file>] [--json]
  gpt-relay source list|enable|disable [source-id] [--db <file>] [--json]
  gpt-relay watch <run-id> [--db <file>] [--json]
  gpt-relay watch serve [--host <address>] [--port <n>] [--allow-remote] [--db <file>]
  gpt-relay ingress github [--host <address>] [--port <n>] [--db <file>]
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
} else if (args[0] === 'workflow') {
  workflow(args[1], args.slice(2));
} else if (args[0] === 'source') {
  await source(args[1], args.slice(2));
} else if (args[0] === 'watch') {
  await watch(args[1], args.slice(2));
} else if (args[0] === 'ingress') {
  await ingress(args[1], args.slice(2));
} else if (args[0] === 'doctor') {
  await doctor(args[1], args.slice(2));
} else if (args[0] === 'service') {
  await service(args[1], args.slice(2));
} else if (['help', '--help', '-h', undefined].includes(args[0])) {
  help();
} else {
  fail(`unknown command: ${args[0]}\nRun gpt-relay --help for usage.`);
}
