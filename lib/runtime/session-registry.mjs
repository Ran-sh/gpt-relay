export class SessionRegistry {
  #store;

  constructor(store) {
    if (!store) throw new Error('SessionRegistry requires a store');
    this.#store = store;
  }

  bind(session) {
    if (!session || typeof session.session_id !== 'string' || session.session_id.length === 0) {
      throw new Error('session_id is required');
    }
    const existing = this.#store.getSession(session.session_id);
    if (existing && existing.task_id !== session.task_id) {
      throw new Error(`cannot rebind session ${session.session_id} from task ${existing.task_id} to ${session.task_id}`);
    }
    this.#store.saveSession(session);
    return this.#store.getSession(session.session_id);
  }

  get(sessionId) {
    return this.#store.getSession(sessionId);
  }

  forTask(taskId, executorId) {
    return this.#store.findSessionForTask(taskId, executorId);
  }

  running() {
    return this.#store.listSessions({ statuses: ['RUNNING'] });
  }

  prepareResume(taskId, executorId, headAttemptId) {
    const session = this.forTask(taskId, executorId);
    if (!session) return null;
    const { pid: _previousPid, ...withoutProcess } = session;
    const resumed = {
      ...withoutProcess,
      head_attempt_id: headAttemptId,
      status: 'RUNNING',
      generation: (Number.isInteger(session.generation) ? session.generation : 1) + 1
    };
    return this.bind(resumed);
  }

  markLost(sessionId, reason = 'process_missing') {
    const session = this.get(sessionId);
    if (!session) return null;
    const lost = this.bind({ ...session, status: 'LOST', lost_reason: reason });
    const attempt = session.head_attempt_id ? this.#store.getAttempt(session.head_attempt_id) : null;
    if (attempt && !['PASS', 'FAIL', 'CANCELLED'].includes(attempt.status)) {
      const evidence = {
        ...(attempt.evidence ?? {}),
        status: 'FAIL',
        summary: `Session ${sessionId} lost: ${reason}`,
        phase: 'process_reconciliation'
      };
      this.#store.saveAttempt({ ...attempt, status: 'FAIL', evidence });
      const workflow = this.#store.getWorkflow(attempt.workflow_run_id);
      if (workflow && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(workflow.state)) {
        this.#store.saveWorkflow({ ...workflow, state: 'FAILED', latest_result: evidence });
      }
      this.#store.createAttention({
        attention_id: `ATT-process-${sessionId}-${session.generation ?? 1}`,
        workflow_run_id: attempt.workflow_run_id,
        type: 'FAILURE',
        message: `Session ${sessionId} lost because its executor process is missing`,
        session_id: sessionId,
        attempt_id: attempt.attempt_id
      });
    }
    return lost;
  }
}
