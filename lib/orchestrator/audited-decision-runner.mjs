import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import { assertDecision } from '../contracts/decision.mjs';
import { redactSecrets } from '../relay/events.mjs';

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class AuditedDecisionRunner {
  #store;
  #provider;
  #id;

  constructor({ store, provider, idFactory = () => `D-${randomUUID()}` }) {
    if (!store || !provider || typeof provider.generate !== 'function') {
      throw new Error('AuditedDecisionRunner requires store and provider');
    }
    this.#store = store;
    this.#provider = provider;
    this.#id = idFactory;
  }

  async decide(packet, options = {}) {
    const decisionId = this.#id();
    const sanitized = redactSecrets(structuredClone(packet));
    const started = Date.now();
    try {
      const generated = await this.#provider.generate(sanitized);
      const decision = assertDecision(generated.decision, options);
      this.#store.saveDecisionAudit({
        decision_id: decisionId,
        workflow_run_id: packet.workflow?.run_id,
        attempt_id: packet.attempt?.attempt_id ?? null,
        provider: this.#provider.id ?? 'unknown',
        model: generated.model ?? this.#provider.model ?? 'unknown',
        packet_hash: hash(sanitized),
        response_hash: hash(decision),
        decision,
        status: 'VALID',
        latency_ms: Date.now() - started,
        usage: generated.usage ?? null,
        response_id: generated.response_id ?? null
      });
      return decision;
    } catch (error) {
      this.#store.saveDecisionAudit({
        decision_id: decisionId,
        workflow_run_id: packet.workflow?.run_id,
        attempt_id: packet.attempt?.attempt_id ?? null,
        provider: this.#provider.id ?? 'unknown',
        model: this.#provider.model ?? 'unknown',
        packet_hash: hash(sanitized),
        status: 'ERROR',
        latency_ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}
