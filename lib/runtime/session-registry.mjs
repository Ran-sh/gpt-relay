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

  prepareResume(taskId, executorId, headAttemptId) {
    const session = this.forTask(taskId, executorId);
    if (!session) return null;
    const resumed = {
      ...session,
      head_attempt_id: headAttemptId,
      status: 'RUNNING',
      generation: (Number.isInteger(session.generation) ? session.generation : 1) + 1
    };
    return this.bind(resumed);
  }

  markLost(sessionId, reason = 'process_missing') {
    const session = this.get(sessionId);
    if (!session) return null;
    return this.bind({ ...session, status: 'LOST', lost_reason: reason });
  }
}
