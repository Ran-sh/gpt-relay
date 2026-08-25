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
  'workflow.pause_requested',
  'workflow.resume_requested',
  'workflow.cancel_requested',
  'workflow.cancelled',
  'workflow.failed',
  'task.delegated',
  'executor.started',
  'executor.completed',
  'executor.failed',
  'approval.requested',
  'approval.granted',
  'approval.denied',
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
      return 'RUNNING';
    case 'human.replied':
      return currentState === 'WAITING_FOR_HUMAN' ? 'RUNNING' : currentState;
    case 'approval.granted':
      return currentState === 'WAITING_FOR_APPROVAL' ? 'RUNNING' : currentState;
    case 'approval.denied':
      return currentState === 'WAITING_FOR_APPROVAL' ? 'FAILED' : currentState;
    case 'workflow.paused':
    case 'workflow.pause_requested':
      return 'PAUSED';
    case 'workflow.resume_requested':
      return currentState === 'PAUSED' ? 'RUNNING' : currentState;
    case 'workflow.cancelled':
    case 'workflow.cancel_requested':
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
