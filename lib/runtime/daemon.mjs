import { randomUUID } from 'node:crypto';

import { assertDecision } from '../contracts/decision.mjs';
import { assertValidTaskVNext } from '../contracts/v2.mjs';
import { buildBoundedStatePacket } from '../orchestrator/state-packet.mjs';
import { RelayPipeline } from '../relay/pipeline.mjs';
import { computeCapabilityGap } from '../workflow/capability-gap.mjs';

function generatedId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function sameMembers(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function defaultValidateResult(result) {
  const valid = result && ['PASS', 'FAIL', 'PARTIAL', 'BLOCKED'].includes(result.status)
    && typeof result.summary === 'string';
  return { valid, acceptance_met: valid && result.status === 'PASS' };
}

const PERMISSION_AUTHORIZATION = Object.freeze({
  'local.shell': 'shell', network: 'network', 'browser.login': 'browser_login',
  credentials: 'credentials', 'git.commit': 'git_commit', 'git.push': 'git_push',
  publish: 'publish', 'deploy.production': 'deploy_production',
  'destructive.operations': 'destructive_operations'
});

function permissionAuthorization(payload = {}) {
  const capability = payload.capability;
  if (PERMISSION_AUTHORIZATION[capability]) return PERMISSION_AUTHORIZATION[capability];
  const operation = String(payload.operation ?? '').toLowerCase();
  if (operation.includes('npm.publish') || operation === 'publish') return 'publish';
  if (operation.includes('git.push')) return 'git_push';
  if (operation.includes('git.commit')) return 'git_commit';
  if (operation.includes('deploy')) return 'deploy_production';
  if (operation.includes('credential') || operation.includes('secret')) return 'credentials';
  if (operation.includes('destructive') || operation.includes('delete')) return 'destructive_operations';
  if (operation.includes('network')) return 'network';
  if (operation.includes('shell')) return 'shell';
  return null;
}

export class WorkflowDaemon {
  #store;
  #registry;
  #decisionRunner;
  #primaryCapabilities;
  #validateResult;
  #maxAttempts;
  #maxActions;
  #id;
  #processSupervisor;

  constructor({
    store,
    registry,
    decisionRunner,
    primaryCapabilities = [],
    validateResult = defaultValidateResult,
    maxAttempts = 3,
    maxActions = 8,
    idFactory = generatedId,
    processSupervisor = null
  }) {
    if (!store || !registry || !decisionRunner) throw new Error('daemon requires store, registry, and decisionRunner');
    this.#store = store;
    this.#registry = registry;
    this.#decisionRunner = decisionRunner;
    this.#primaryCapabilities = [...primaryCapabilities];
    this.#validateResult = validateResult;
    this.#maxAttempts = maxAttempts;
    this.#maxActions = maxActions;
    this.#id = idFactory;
    this.#processSupervisor = processSupervisor;
  }

  async run(task, context = {}) {
    return this.#execute(task, context, null);
  }

  async resume(workflowRunId, input = {}, context = {}) {
    const workflow = this.#store.getWorkflow(workflowRunId);
    if (!workflow) throw new Error(`unknown workflow: ${workflowRunId}`);
    const allowed = {
      WAITING_FOR_HUMAN: 'human.replied',
      WAITING_FOR_APPROVAL: 'approval.granted',
      PAUSED: 'workflow.resume_requested',
      VERIFYING: 'workflow.resume_requested'
    };
    if (allowed[workflow.state] !== input.type) {
      throw new Error(`cannot apply ${input.type ?? 'unknown input'} while workflow is ${workflow.state}`);
    }
    if (!workflow.task || !workflow.checkpoint) throw new Error(`workflow ${workflowRunId} has no durable checkpoint`);
    let resumedTask = structuredClone(workflow.checkpoint.current_task ?? workflow.task);
    if (input.type === 'approval.granted') {
      const attention = input.attention_id ? this.#store.getAttention?.(input.attention_id) : null;
      if (!attention || attention.workflow_run_id !== workflowRunId || attention.type !== 'APPROVAL') {
        throw new Error('approval grant requires its matching durable APPROVAL Attention');
      }
      const authorization = attention.required_authorization;
      if (!authorization || !(authorization in resumedTask.authorization)) {
        throw new Error('approval Attention does not name a valid authorization');
      }
      resumedTask.authorization = { ...resumedTask.authorization, [authorization]: true };
    }
    const checkpoint = {
      ...workflow.checkpoint,
      current_task: resumedTask,
      handoff: [workflow.checkpoint.handoff, input.response].filter(Boolean).join('\n')
    };
    return this.#execute(workflow.task, { ...workflow.execution_context, ...context }, {
      workflow,
      checkpoint
    });
  }

  async #execute(task, context = {}, recovery = null) {
    assertValidTaskVNext(task);
    const checkpoint = recovery?.checkpoint ?? {};
    const workflowRunId = recovery?.workflow?.run_id ?? context.workflow_run_id ?? this.#id('W');
    const existingWorkflow = recovery ? null : this.#store.getWorkflow(workflowRunId);
    if (existingWorkflow?.task_id && existingWorkflow.task_id !== task.id) {
      throw new Error(`workflow ${workflowRunId} is already bound to task ${existingWorkflow.task_id}`);
    }
    let currentTask = structuredClone(checkpoint.current_task ?? task);
    let attemptNumber = checkpoint.attempt_count ?? 0;
    let actionCount = checkpoint.action_count ?? 0;
    let resumeSessionId = checkpoint.resume_session_id ?? null;
    let handoff = checkpoint.handoff ?? '';
    let latestResult = checkpoint.latest_result ?? null;
    let latestValidation = checkpoint.latest_validation ?? null;
    const baseWorkflow = {
      ...(recovery?.workflow ?? {}),
      run_id: workflowRunId,
      objective: task.objective,
      state: 'RUNNING',
      task_id: task.id,
      task: structuredClone(task),
      execution_context: {
        cwd: context.cwd ?? recovery?.workflow?.execution_context?.cwd ?? process.cwd(),
        workspace_id: context.workspace_id ?? recovery?.workflow?.execution_context?.workspace_id ?? 'default'
      }
    };
    const durableCheckpoint = () => ({
      current_task: structuredClone(currentTask),
      attempt_count: attemptNumber,
      action_count: actionCount,
      resume_session_id: resumeSessionId,
      handoff,
      latest_result: latestResult,
      latest_validation: latestValidation
    });
    const saveWorkflow = (workflow) => this.#store.saveWorkflow({
      ...workflow,
      task: structuredClone(task),
      execution_context: baseWorkflow.execution_context,
      checkpoint: durableCheckpoint()
    });
    saveWorkflow(baseWorkflow);

    const gap = computeCapabilityGap(task.required_capabilities, this.#primaryCapabilities);
    if (gap.length === 0) {
      const result = context.onPrimary ? await context.onPrimary(task) : null;
      const validation = await this.#validateResult(result, task, null);
      const state = validation.valid && validation.acceptance_met ? 'COMPLETED' : 'RUNNING';
      saveWorkflow({ ...baseWorkflow, state, owner: 'primary', latest_result: result });
      return { workflow_run_id: workflowRunId, owner: 'primary', state, attempts: 0, human_actions: 0 };
    }

    if (!sameMembers(gap, task.delegated_scope.required_capabilities)) {
      throw new Error(`delegated scope must equal the capability gap: ${gap.join(', ')}`);
    }

    const match = await this.#registry.match(gap);
    if (!match.adapter) {
      const message = `No ready executor provides: ${gap.join(', ')}`;
      this.#store.createAttention({
        attention_id: this.#id('ATT'),
        workflow_run_id: workflowRunId,
        type: 'CAPABILITY',
        message,
        diagnostics: match.diagnostics
      });
      saveWorkflow({ ...baseWorkflow, state: 'WAITING_FOR_CAPABILITY' });
      return {
        workflow_run_id: workflowRunId,
        owner: 'relay',
        state: 'WAITING_FOR_CAPABILITY',
        attempts: 0,
        human_actions: 1
      };
    }

    const adapter = match.adapter;
    const pipeline = new RelayPipeline({ store: this.#store });
    while (attemptNumber < this.#maxAttempts && actionCount < this.#maxActions) {
      attemptNumber += 1;
      const attemptId = this.#id('A');
      let generation = 1;
      if (resumeSessionId) {
        const prior = this.#store.getSession(resumeSessionId);
        generation = (prior?.generation ?? 1) + 1;
        const { pid: _previousPid, ...priorWithoutProcess } = prior ?? {};
        this.#store.saveSession({
          ...priorWithoutProcess,
          session_id: resumeSessionId,
          executor_id: adapter.id,
          workspace_id: context.workspace_id ?? 'default',
          task_id: task.id,
          conversation_root_id: prior?.conversation_root_id ?? resumeSessionId,
          head_attempt_id: attemptId,
          status: 'RUNNING',
          generation
        });
      }

      const attempt = {
        attempt_id: attemptId,
        task_id: task.id,
        workflow_run_id: workflowRunId,
        number: attemptNumber,
        status: 'RUNNING',
        evidence: {}
      };
      this.#store.saveAttempt(attempt);
      saveWorkflow({ ...baseWorkflow, state: 'RUNNING', attempt: attemptNumber });

      const executionContext = {
        cwd: context.cwd ?? process.cwd(),
        workspace_id: context.workspace_id ?? 'default',
        workflow_run_id: workflowRunId,
        attempt_id: attemptId,
        source: adapter.id,
        session_id: resumeSessionId,
        generation,
        handoff
      };
      let handle;
      let permissionStop = null;
      try {
        handle = resumeSessionId && typeof adapter.resume === 'function'
          ? await adapter.resume({ session_id: resumeSessionId }, currentTask, executionContext)
          : await adapter.start(currentTask, executionContext);
        if (executionContext.session_id && Number.isInteger(handle?.pid) && handle.pid > 0) {
          const session = this.#store.getSession(executionContext.session_id);
          if (session) this.#processSupervisor?.register({ pid: handle.pid, session });
        }

        for await (const rawEvent of adapter.events(handle)) {
          const announcedSession = rawEvent?.thread_id ?? rawEvent?.session_id ?? rawEvent?.payload?.session_id;
          if (rawEvent?.type === 'thread.started' && announcedSession) {
            executionContext.session_id = announcedSession;
            const session = {
              session_id: announcedSession,
              executor_id: adapter.id,
              workspace_id: context.workspace_id ?? 'default',
              task_id: task.id,
              conversation_root_id: resumeSessionId ?? announcedSession,
              head_attempt_id: attemptId,
              status: 'RUNNING',
              generation
            };
            this.#store.saveSession(session);
            if (Number.isInteger(handle?.pid) && handle.pid > 0) {
              this.#processSupervisor?.register({ pid: handle.pid, session });
            }
          }
          const accepted = await pipeline.accept(rawEvent, executionContext);
          if (accepted.event.type === 'permission.requested') {
            const requiredAuthorization = permissionAuthorization(accepted.event.payload);
            const security = !requiredAuthorization
              || ['credentials', 'destructive_operations'].includes(requiredAuthorization);
            permissionStop = {
              event: accepted.event,
              requiredAuthorization,
              attentionType: security ? 'SECURITY' : 'APPROVAL',
              state: security ? 'WAITING_FOR_HUMAN' : 'WAITING_FOR_APPROVAL'
            };
            await adapter.cancel?.(handle);
            break;
          }
        }

        if (permissionStop) {
          const { event, requiredAuthorization, attentionType, state } = permissionStop;
          const evidence = {
            status: 'BLOCKED', summary: `Executor requested permission for ${event.payload.operation ?? 'unknown operation'}`,
            phase: 'permission_request', event_id: event.event_id
          };
          this.#store.saveAttempt({ ...attempt, status: 'BLOCKED', evidence });
          if (executionContext.session_id) {
            const existing = this.#store.getSession(executionContext.session_id);
            if (existing) this.#store.saveSession({ ...existing, status: 'READY' });
            this.#processSupervisor?.unregister(executionContext.session_id);
          }
          this.#store.createAttention({
            attention_id: `ATT-permission-${event.event_id}`,
            workflow_run_id: workflowRunId,
            type: attentionType,
            message: evidence.summary,
            operation: event.payload.operation ?? null,
            required_authorization: requiredAuthorization,
            executor_id: adapter.id,
            attempt_id: attemptId,
            event_id: event.event_id
          });
          saveWorkflow({ ...baseWorkflow, state, attempt: attemptNumber, latest_result: evidence });
          return {
            workflow_run_id: workflowRunId, owner: 'relay', state,
            attempts: attemptNumber, human_actions: 1, latest_result: evidence
          };
        }

        latestResult = await adapter.collectResult(handle);
      } catch (error) {
        const summary = error instanceof Error ? error.message : String(error);
        const sessionId = executionContext.session_id;
        if (sessionId) {
          const existing = this.#store.getSession(sessionId);
          if (existing) this.#store.saveSession({ ...existing, status: 'LOST', lost_reason: 'executor_lifecycle_failure' });
          this.#processSupervisor?.unregister(sessionId);
        }
        const evidence = { status: 'FAIL', summary, phase: 'executor_lifecycle' };
        this.#store.saveAttempt({ ...attempt, status: 'FAIL', evidence });
        this.#store.createAttention({
          attention_id: this.#id('ATT'),
          workflow_run_id: workflowRunId,
          type: 'FAILURE',
          message: `Executor lifecycle failed: ${summary}`,
          attempt_id: attemptId
        });
        saveWorkflow({ ...baseWorkflow, state: 'FAILED', attempt: attemptNumber, latest_result: evidence });
        return {
          workflow_run_id: workflowRunId,
          owner: 'relay',
          state: 'FAILED',
          attempts: attemptNumber,
          human_actions: 1,
          latest_result: evidence
        };
      }
      const sessionId = latestResult.session_id ?? executionContext.session_id;
      if (sessionId) this.#processSupervisor?.unregister(sessionId);
      if (sessionId) {
        const existing = this.#store.getSession(sessionId);
        this.#store.saveSession({
          ...existing,
          session_id: sessionId,
          executor_id: adapter.id,
          workspace_id: context.workspace_id ?? 'default',
          task_id: task.id,
          conversation_root_id: existing?.conversation_root_id ?? sessionId,
          head_attempt_id: attemptId,
          status: latestResult.session_lost ? 'LOST' : 'READY',
          generation
        });
      }

      this.#store.saveAttempt({ ...attempt, status: latestResult.status, evidence: latestResult });
      await pipeline.accept({
        event_id: this.#id('E'),
        type: 'result.created',
        source: 'relay',
        payload: {
          status: latestResult.status,
          summary: latestResult.summary,
          artifacts: latestResult.artifacts ?? []
        }
      }, { ...executionContext, source: 'relay', session_id: sessionId });

      try {
        latestValidation = await this.#validateResult(latestResult, currentTask, attempt);
      } catch (error) {
        latestValidation = { valid: false, acceptance_met: false, reason: error.message };
      }
      await pipeline.accept({
        event_id: this.#id('E'),
        type: latestValidation.valid ? 'result.validated' : 'result.rejected',
        source: 'relay',
        payload: {
          result_status: latestResult.status,
          acceptance_met: latestValidation.acceptance_met === true,
          reason: latestValidation.reason ?? null
        }
      }, { ...executionContext, source: 'relay', session_id: sessionId });

      const verifyingWorkflow = {
        ...baseWorkflow,
        state: 'VERIFYING',
        attempt: attemptNumber,
        latest_result: latestResult
      };
      saveWorkflow(verifyingWorkflow);
      const packet = buildBoundedStatePacket({
        workflow: verifyingWorkflow,
        task: currentTask,
        attempt: { ...attempt, status: latestResult.status },
        session: sessionId ? this.#store.getSession(sessionId) : null,
        latestResult,
        acceptance: latestValidation,
        attention: this.#store.listAttention({ openOnly: true }),
        events: this.#store.listEvents({ workflowRunId, limit: 200 })
      });
      const decision = assertDecision(
        await this.#decisionRunner.decide(packet, { task: currentTask }),
        { task: currentTask }
      );
      actionCount += 1;

      if (decision.decision === 'COMPLETE') {
        if (!(latestValidation.valid && latestValidation.acceptance_met && latestResult.status === 'PASS')) {
          throw new Error('COMPLETE requires a validated PASS result that satisfies acceptance');
        }
        saveWorkflow({ ...verifyingWorkflow, state: 'COMPLETED', decision });
        return {
          workflow_run_id: workflowRunId,
          owner: 'relay',
          state: 'COMPLETED',
          attempts: attemptNumber,
          human_actions: 0,
          latest_result: latestResult
        };
      }

      if (decision.decision === 'FOLLOW_UP') {
        currentTask = { ...currentTask, delegated_scope: decision.delegated_scope };
        assertValidTaskVNext(currentTask);
        resumeSessionId = sessionId && typeof adapter.resume === 'function' ? sessionId : null;
        handoff = decision.reason;
        continue;
      }
      if (decision.decision === 'RETRY' || decision.decision === 'DISPATCH') {
        if (decision.delegated_scope) currentTask = { ...currentTask, delegated_scope: decision.delegated_scope };
        resumeSessionId = null;
        handoff = decision.reason;
        continue;
      }
      if (decision.decision === 'ASK_HUMAN' || decision.decision === 'REQUEST_APPROVAL') {
        const state = decision.decision === 'ASK_HUMAN' ? 'WAITING_FOR_HUMAN' : 'WAITING_FOR_APPROVAL';
        resumeSessionId = sessionId && typeof adapter.resume === 'function' ? sessionId : null;
        handoff = decision.reason;
        this.#store.createAttention({
          attention_id: this.#id('ATT'),
          workflow_run_id: workflowRunId,
          type: decision.decision === 'ASK_HUMAN' ? 'DECISION' : 'APPROVAL',
          message: decision.reason
        });
        saveWorkflow({ ...verifyingWorkflow, state, decision });
        return { workflow_run_id: workflowRunId, owner: 'relay', state, attempts: attemptNumber, human_actions: 1 };
      }
      if (decision.decision === 'PAUSE' || decision.decision === 'WAIT') {
        const state = decision.decision === 'PAUSE' ? 'PAUSED' : 'VERIFYING';
        saveWorkflow({ ...verifyingWorkflow, state, decision });
        return { workflow_run_id: workflowRunId, owner: 'relay', state, attempts: attemptNumber, human_actions: 0 };
      }
      if (decision.decision === 'FAIL') {
        saveWorkflow({ ...verifyingWorkflow, state: 'FAILED', decision });
        return { workflow_run_id: workflowRunId, owner: 'relay', state: 'FAILED', attempts: attemptNumber, human_actions: 0 };
      }
    }

    const reason = attemptNumber >= this.#maxAttempts ? 'max attempts exhausted' : 'max actions exhausted';
    this.#store.createAttention({
      attention_id: this.#id('ATT'),
      workflow_run_id: workflowRunId,
      type: 'FAILURE',
      message: reason
    });
    saveWorkflow({ ...baseWorkflow, state: 'FAILED', latest_result: latestResult, reason });
    return {
      workflow_run_id: workflowRunId,
      owner: 'relay',
      state: 'FAILED',
      attempts: attemptNumber,
      human_actions: 1,
      latest_result: latestResult
    };
  }
}
