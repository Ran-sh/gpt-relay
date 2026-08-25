import { normalizeExecutorEvent } from './events.mjs';

function payloadBytes(payload) {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

function previewPayload(payload, maxLength = 80) {
  const text = JSON.stringify(payload);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

export class RelayPipeline {
  #store;
  #route;
  #maxInlineBytes;
  #now;
  #classifier;

  constructor({
    store,
    route = async () => {},
    classifier = null,
    maxInlineBytes = 16_384,
    now = () => new Date().toISOString()
  }) {
    if (!store) throw new Error('RelayPipeline requires a store');
    if (typeof route !== 'function') throw new TypeError('route must be a function');
    this.#store = store;
    this.#route = route;
    this.#maxInlineBytes = Math.max(128, maxInlineBytes);
    this.#now = now;
    this.#classifier = classifier;
  }

  async accept(rawEvent, context = {}) {
    const event = normalizeExecutorEvent(rawEvent, context, { now: this.#now });
    if (event.type === 'natural_language' && this.#classifier) {
      event.payload = {
        ...event.payload,
        semantic_type: this.#classifier.classify(event.payload?.text)
      };
    }
    if (typeof event.workflow_run_id !== 'string' || event.workflow_run_id.length === 0) {
      throw new Error('canonical event requires workflow_run_id');
    }

    if (event.session_id && Number.isInteger(event.generation)) {
      const current = this.#store.getSession(event.session_id);
      if (current && Number.isInteger(current.generation) && event.generation !== current.generation) {
        return { status: 'stale', event };
      }
    }

    if (payloadBytes(event.payload) > this.#maxInlineBytes) {
      const artifactRef = `artifact://${event.event_id}`;
      this.#store.saveArtifact({
        artifact_ref: artifactRef,
        workflow_run_id: event.workflow_run_id,
        kind: 'event-payload',
        content: event.payload
      });
      event.payload = {
        truncated: true,
        artifact_ref: artifactRef,
        preview: previewPayload(event.payload)
      };
    }

    const persisted = this.#store.appendEvent(event);
    if (persisted.status === 'collision') return { status: 'collision', event: persisted.event };
    const canonicalEvent = persisted.event;
    if (persisted.status === 'duplicate' && (canonicalEvent.lane === 'trace' || this.#store.isEventRouted(canonicalEvent.event_id))) {
      return { status: 'duplicate', event: canonicalEvent };
    }
    if (canonicalEvent.lane === 'trace') return { status: 'stored_trace', event: canonicalEvent };

    await this.#route(canonicalEvent);
    this.#store.markEventRouted(canonicalEvent.event_id);
    return { status: 'routed', event: canonicalEvent };
  }

  async drainPending({ workflowRunId, limit = 100 }) {
    const pending = this.#store.listPendingControlEvents({ workflowRunId, limit });
    let routed = 0;
    let failed = 0;
    for (const event of pending) {
      try {
        await this.#route(event);
        this.#store.markEventRouted(event.event_id);
        routed += 1;
      } catch {
        failed += 1;
        break;
      }
    }
    return { routed, failed };
  }
}
