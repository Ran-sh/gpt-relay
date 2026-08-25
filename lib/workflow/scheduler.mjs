const TRIGGERS = Object.freeze({
  'workflow.created': 'initial_invocation',
  'executor.completed': 'executor_completed',
  'executor.failed': 'executor_failed',
  'result.validated': 'result_validated',
  'human.replied': 'human_replied',
  'capability.became_ready': 'capability_became_ready',
  'workflow.idle_timeout': 'idle_timeout'
});

export class WorkflowScheduler {
  #consumed;

  constructor({ consumedEventIds = [] } = {}) {
    this.#consumed = new Set(consumedEventIds);
  }

  propose(event) {
    if (!event || typeof event.event_id !== 'string' || event.event_id.length === 0) {
      throw new Error('scheduler events require event_id');
    }
    if (this.#consumed.has(event.event_id)) return null;
    const trigger = TRIGGERS[event.type];
    if (!trigger) return null;
    this.#consumed.add(event.event_id);
    return { trigger, event_id: event.event_id };
  }

  consumedEventIds() {
    return [...this.#consumed];
  }
}
