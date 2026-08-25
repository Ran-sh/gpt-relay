import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NotificationDispatcher } from './notifier.mjs';
import { ConsoleNotificationTransport } from './transports/console.mjs';
import { JsonlFileNotificationTransport } from './transports/jsonl-file.mjs';

const RESUME_TYPES = new Set(['human.replied', 'approval.granted', 'workflow.resume_requested']);
const TASK_TYPES = new Set(['task.created', 'task.resumed']);
const INLINE_TASK_TYPES = new Set(['scheduled.task']);
const EXTERNAL_TRIGGER_TYPES = new Set(['github.ci_failed', 'github.pr_updated']);

export const DEFAULT_PRIMARY_CAPABILITIES = Object.freeze(['reasoning']);

export function createProductionNotifier(store, { jsonlFile = null, console = true } = {}) {
  const transports = {};
  if (console) transports.console = new ConsoleNotificationTransport();
  if (jsonlFile) transports.jsonl = new JsonlFileNotificationTransport(jsonlFile);
  return new NotificationDispatcher({ store, transports });
}

export function createProductionRoute(store, { workspaceRoot = process.cwd() } = {}) {
  if (!store) throw new Error('production route requires runtime store');
  const root = path.resolve(workspaceRoot);
  return async (event) => {
    if (EXTERNAL_TRIGGER_TYPES.has(event?.type)) {
      const workflow = event.workflow_run_id ? store.getWorkflow(event.workflow_run_id) : null;
      if (!workflow || !['VERIFYING', 'PAUSED'].includes(workflow.state)) return;
      store.enqueueJob({
        job_id: `J-event-${event.event_id}`,
        workflow_run_id: event.workflow_run_id,
        type: 'workflow.resume_requested',
        payload: {
          reason: `External trigger: ${event.type}`,
          trigger: { event_id: event.event_id, type: event.type, payload: event.payload ?? {} }
        }
      });
      return;
    }
    if (!TASK_TYPES.has(event?.type)) return;
    store.enqueueJob({
      job_id: `J-event-${event.event_id}`,
      workflow_run_id: event.workflow_run_id,
      type: event.type,
      payload: { ...event.payload, workspace_root: root }
    });
  };
}

export function createRuntimeJobHandler({ store = null, daemon, cwd = process.cwd() } = {}) {
  if (!daemon || typeof daemon.run !== 'function' || typeof daemon.resume !== 'function') {
    throw new Error('production runtime requires a workflow daemon');
  }
  return async (job) => {
    const recoveredWorkflow = store && (job?.attempts ?? 1) > 1
      ? store.getWorkflow(job.workflow_run_id)
      : null;
    if (recoveredWorkflow && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(recoveredWorkflow.state)) {
      return recoveredWorkflow;
    }
    if (TASK_TYPES.has(job?.type)) {
      if (recoveredWorkflow) {
        if (['WAITING_FOR_HUMAN', 'WAITING_FOR_APPROVAL', 'WAITING_FOR_CAPABILITY', 'PAUSED']
            .includes(recoveredWorkflow.state)) {
          return recoveredWorkflow;
        }
        if ((recoveredWorkflow.checkpoint?.attempt_count ?? 0) > 0) {
          const attentionId = `ATT-recovery-${job.job_id ?? job.workflow_run_id}`;
          store.createAttention({
            attention_id: attentionId,
            workflow_run_id: recoveredWorkflow.run_id,
            type: 'RECOVERY',
            message: 'A worker crashed after executor side effects became possible; automatic redispatch was paused to prevent duplication',
            job_id: job.job_id ?? null
          });
          const paused = {
            ...recoveredWorkflow,
            state: 'PAUSED',
            reason: 'uncertain executor state after worker crash',
            recovery_attention_id: attentionId
          };
          store.saveWorkflow(paused);
          return paused;
        }
      }
      if (typeof job.payload?.path !== 'string' || job.payload.path.length === 0) {
        throw new Error(`${job.type} job requires payload.path`);
      }
      const absolute = path.resolve(cwd, job.payload.path);
      let task;
      try {
        task = JSON.parse(await readFile(absolute, 'utf8'));
      } catch (error) {
        throw new Error(`cannot read runtime task ${absolute}: ${error.message}`);
      }
      const workspaceRoot = path.resolve(job.payload?.workspace_root ?? cwd);
      const relativeContract = path.relative(workspaceRoot, absolute);
      if (relativeContract.startsWith('..') || path.isAbsolute(relativeContract)) {
        throw new Error(`runtime task is outside workspace root: ${absolute}`);
      }
      return daemon.run(task, {
        cwd: workspaceRoot,
        workspace_id: job.workflow_run_id ?? 'default',
        workflow_run_id: job.workflow_run_id ?? null
      });
    }
    if (INLINE_TASK_TYPES.has(job?.type)) {
      if (!job.payload?.task || typeof job.payload.task !== 'object') {
        throw new Error(`${job.type} job requires payload.task`);
      }
      const workspaceRoot = path.resolve(job.payload?.workspace_root ?? cwd);
      return daemon.run(structuredClone(job.payload.task), {
        cwd: workspaceRoot,
        workspace_id: job.workflow_run_id ?? 'default',
        workflow_run_id: job.workflow_run_id ?? null
      });
    }
    if (RESUME_TYPES.has(job?.type)) {
      return daemon.resume(job.workflow_run_id, {
        type: job.type,
        response: job.payload?.response ?? job.payload?.reason ?? null,
        attention_id: job.payload?.attention_id ?? null
      });
    }
    if (job?.type === 'approval.denied') {
      if (!store) throw new Error('approval denial requires runtime store');
      const workflow = store.getWorkflow(job.workflow_run_id);
      if (!workflow) throw new Error(`unknown workflow: ${job.workflow_run_id}`);
      const failed = {
        ...workflow,
        state: 'FAILED',
        reason: job.payload?.response ?? 'approval denied'
      };
      store.saveWorkflow(failed);
      return failed;
    }
    throw new Error(`unsupported runtime job type: ${job?.type ?? 'missing'}`);
  };
}
