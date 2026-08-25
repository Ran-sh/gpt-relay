export class ProcessSupervisor {
  #sessions;
  #isAlive;
  #processes = new Map();

  constructor({ sessions, isAlive = defaultIsAlive }) {
    if (!sessions || typeof isAlive !== 'function') {
      throw new Error('ProcessSupervisor requires sessions and isAlive');
    }
    this.#sessions = sessions;
    this.#isAlive = isAlive;
  }

  register({ pid, session }) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('process pid must be a positive integer');
    const bound = this.#sessions.bind({ ...session, pid });
    this.#processes.set(bound.session_id, { pid, session_id: bound.session_id });
    return { pid, session_id: bound.session_id };
  }

  unregister(sessionId) {
    return this.#processes.delete(sessionId);
  }

  async reconcile() {
    const alive = [];
    const lost = [];
    const processes = new Map(this.#processes);
    for (const session of this.#sessions.running()) {
      if (Number.isInteger(session.pid) && session.pid > 0) {
        processes.set(session.session_id, { pid: session.pid, session_id: session.session_id });
      }
    }
    for (const [sessionId, process] of processes) {
      let running = false;
      try {
        running = await this.#isAlive(process.pid);
      } catch {
        running = false;
      }
      if (running) {
        alive.push(sessionId);
      } else {
        this.#sessions.markLost(sessionId, 'process_missing_during_reconciliation');
        this.#processes.delete(sessionId);
        lost.push(sessionId);
      }
    }
    return { alive, lost };
  }
}

async function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    return false;
  }
}
