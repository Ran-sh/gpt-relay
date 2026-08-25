export const WORKFLOW_STATES = Object.freeze([
  'RUNNING',
  'WAITING_FOR_EXECUTOR',
  'WAITING_FOR_CAPABILITY',
  'WAITING_FOR_APPROVAL',
  'WAITING_FOR_HUMAN',
  'VERIFYING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
]);

const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const KNOWN_EVENTS = new Set([
  'workflow.created',
  'workflow.paused',
  'workflow.resumed',
  'workflow.cancelled',
  'workflow.failed',
  'task.delegated',
  'executor.started',
  'executor.completed',
  'executor.failed',
  'approval.requested',
  'human.input_required',
  'human.replied',
  'capability.became_ready',
  'result.validated',
  'result.rejected'
]);

export function transitionWorkflow(currentState, event) {
  if (!WORKFLOW_STATES.includes(currentState)) throw new Error(`unknown workflow state: ${currentState}`);
  if (!event || !KNOWN_EVENTS.has(event.type)) throw new Error(`unknown workflow event: ${event?.type}`);
  if (TERMINAL_STATES.has(currentState)) return currentState;

  switch (event.type) {
    case 'workflow.created':
    case 'workflow.resumed':
    case 'human.replied':
      return 'RUNNING';
    case 'workflow.paused':
      return 'PAUSED';
    case 'workflow.cancelled':
      return 'CANCELLED';
    case 'workflow.failed':
      return 'FAILED';
    case 'task.delegated':
      return event.payload?.executor_ready === true ? 'WAITING_FOR_EXECUTOR' : 'WAITING_FOR_CAPABILITY';
    case 'executor.started':
      return 'RUNNING';
    case 'executor.completed':
    case 'executor.failed':
      return 'VERIFYING';
    case 'approval.requested':
      return 'WAITING_FOR_APPROVAL';
    case 'human.input_required':
      return 'WAITING_FOR_HUMAN';
    case 'capability.became_ready':
      return currentState === 'WAITING_FOR_CAPABILITY' ? 'RUNNING' : currentState;
    case 'result.rejected':
      return 'RUNNING';
    case 'result.validated':
      return event.payload?.result_status === 'PASS' && event.payload?.acceptance_met === true
        ? 'COMPLETED'
        : 'RUNNING';
    default:
      throw new Error(`unhandled workflow event: ${event.type}`);
  }
}
