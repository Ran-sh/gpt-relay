import { assertDecision } from '../contracts/decision.mjs';

export class ScriptedDecisionRunner {
  #decisions;
  calls = [];

  constructor(decisions) {
    this.#decisions = decisions.map((decision) => structuredClone(decision));
  }

  async decide(packet, options = {}) {
    this.calls.push(structuredClone(packet));
    if (this.#decisions.length === 0) throw new Error('scripted decision runner is exhausted');
    return assertDecision(this.#decisions.shift(), options);
  }
}

export class TypedDecisionRunner {
  #generate;

  constructor({ generate }) {
    if (typeof generate !== 'function') throw new TypeError('generate must be a function');
    this.#generate = generate;
  }

  async decide(packet, options = {}) {
    const response = await this.#generate(structuredClone(packet));
    let decision = response;
    if (typeof response === 'string') {
      try {
        decision = JSON.parse(response);
      } catch (error) {
        throw new Error(`decision runner returned invalid JSON: ${error.message}`);
      }
    }
    return assertDecision(decision, options);
  }
}
