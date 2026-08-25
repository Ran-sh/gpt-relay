import { redactSecrets } from '../relay/events.mjs';

function truncate(value, limit) {
  if (typeof value !== 'string') return value;
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function collectArtifactRefs(value, refs = new Set()) {
  if (typeof value === 'string' && value.startsWith('artifact://')) refs.add(value);
  else if (Array.isArray(value)) value.forEach((item) => collectArtifactRefs(item, refs));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectArtifactRefs(item, refs));
  return refs;
}

function compactEvent(event) {
  const payload = event.payload ?? {};
  return {
    event_id: event.event_id,
    type: event.type,
    timestamp: event.timestamp,
    payload: {
      ...(payload.status !== undefined ? { status: payload.status } : {}),
      ...(payload.result_status !== undefined ? { result_status: payload.result_status } : {}),
      ...(payload.acceptance_met !== undefined ? { acceptance_met: payload.acceptance_met } : {}),
      ...(payload.reason !== undefined ? { reason: truncate(payload.reason, 160) } : {}),
      ...(payload.artifact_ref !== undefined ? { artifact_ref: payload.artifact_ref } : {})
    }
  };
}

function minimalPacket(packet, maxBytes) {
  const minimal = {
    objective: truncate(packet.objective, 160),
    workflow_state: packet.workflow_state,
    current_task: { id: packet.current_task.id },
    attempt: packet.attempt ? { number: packet.attempt.number, status: packet.attempt.status } : null,
    latest_result: packet.latest_result ? { status: packet.latest_result.status } : null,
    handoff: truncate(packet.handoff, 160),
    artifact_refs: packet.artifact_refs.slice(0, 4),
    recent_events: packet.recent_events.slice(-1)
  };
  while (byteLength(minimal) > maxBytes && minimal.handoff.length > 16) {
    minimal.handoff = truncate(minimal.handoff, Math.floor(minimal.handoff.length / 2));
  }
  return minimal;
}

export function buildBoundedStatePacket(input, { maxBytes = 16_384, maxEvents = 12 } = {}) {
  const boundedBytes = Math.max(768, maxBytes);
  const controlEvents = (input.events ?? [])
    .filter((event) => event.lane === 'control')
    .slice(-Math.max(1, maxEvents))
    .map(compactEvent);
  const artifactRefs = [...collectArtifactRefs({
    result: input.latestResult,
    events: controlEvents
  })];
  const resultStatus = input.latestResult?.status ?? 'UNKNOWN';
  const resultSummary = truncate(input.latestResult?.summary ?? '', 600);
  const packet = redactSecrets({
    objective: truncate(input.workflow?.objective ?? input.task?.objective ?? '', 400),
    workflow_state: input.workflow?.state ?? 'RUNNING',
    current_task: {
      id: input.task?.id,
      objective: truncate(input.task?.objective ?? '', 320),
      required_capabilities: input.task?.required_capabilities ?? [],
      delegated_scope: input.task?.delegated_scope ? {
        objective: truncate(input.task.delegated_scope.objective, 320),
        required_capabilities: input.task.delegated_scope.required_capabilities,
        allowed_changes: input.task.delegated_scope.allowed_changes,
        validation: input.task.delegated_scope.validation ?? []
      } : null,
      authorization: input.task?.authorization ?? {}
    },
    attempt: input.attempt ? {
      attempt_id: input.attempt.attempt_id,
      number: input.attempt.number,
      status: input.attempt.status
    } : null,
    executor_session: input.session ? {
      executor_id: input.session.executor_id,
      status: input.session.status,
      resumable: input.session.status !== 'LOST'
    } : null,
    latest_result: input.latestResult ? {
      status: resultStatus,
      summary: resultSummary
    } : null,
    acceptance: input.acceptance ?? null,
    attention: (input.attention ?? []).slice(0, 8).map((item) => ({
      type: item.type,
      message: truncate(item.message, 240)
    })),
    handoff: truncate(`Attempt ${input.attempt?.number ?? '?'} result ${resultStatus}: ${resultSummary}`, 480),
    recent_events: controlEvents,
    artifact_refs: artifactRefs
  });

  while (byteLength(packet) > boundedBytes && packet.recent_events.length > 1) packet.recent_events.shift();
  for (const key of ['summary']) {
    while (byteLength(packet) > boundedBytes && packet.latest_result?.[key]?.length > 64) {
      packet.latest_result[key] = truncate(packet.latest_result[key], Math.floor(packet.latest_result[key].length / 2));
    }
  }
  while (byteLength(packet) > boundedBytes && packet.handoff.length > 64) {
    packet.handoff = truncate(packet.handoff, Math.floor(packet.handoff.length / 2));
  }
  while (byteLength(packet) > boundedBytes && packet.attention.length > 0) packet.attention.pop();

  return byteLength(packet) <= boundedBytes ? packet : minimalPacket(packet, boundedBytes);
}
