import { readFile } from 'node:fs/promises';
import path from 'node:path';

const RESUME_TYPES = new Set(['human.replied', 'approval.granted', 'workflow.resume_requested']);
const TASK_TYPES = new Set(['task.created', 'task.resumed']);

export const DEFAULT_PRIMARY_CAPABILITIES = Object.freeze(['reasoning']);

export function createRuntimeJobHandler({ store = null, daemon, cwd = process.cwd() } = {}) {
  if (!daemon || typeof daemon.run !== 'function' || typeof daemon.resume !== 'function') {
    throw new Error('production runtime requires a workflow daemon');
  }
  return async (job) => {
    if (TASK_TYPES.has(job?.type)) {
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
      return daemon.run(task, {
        cwd: path.dirname(absolute),
        workspace_id: job.workflow_run_id ?? 'default',
        workflow_run_id: job.workflow_run_id ?? null
      });
    }
    if (RESUME_TYPES.has(job?.type)) {
      return daemon.resume(job.workflow_run_id, {
        type: job.type,
        response: job.payload?.response ?? null,
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
