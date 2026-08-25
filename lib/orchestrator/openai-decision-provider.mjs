import { redactSecrets } from '../relay/events.mjs';

const DECISION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'reason', 'delegated_scope'],
  properties: {
    decision: {
      type: 'string',
      enum: ['DISPATCH', 'FOLLOW_UP', 'RETRY', 'WAIT', 'ASK_HUMAN', 'REQUEST_APPROVAL', 'PAUSE', 'COMPLETE', 'FAIL']
    },
    reason: { type: 'string', minLength: 1 },
    delegated_scope: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['objective', 'required_capabilities', 'allowed_changes', 'forbidden_changes', 'return'],
          properties: {
            objective: { type: 'string', minLength: 1 },
            required_capabilities: { type: 'array', items: { type: 'string' } },
            allowed_changes: { type: 'array', items: { type: 'string' } },
            forbidden_changes: { type: 'array', items: { type: 'string' } },
            validation: { type: 'array', items: { type: 'string' } },
            return: { type: 'array', items: { type: 'string' } }
          }
        }
      ]
    }
  }
});

const SYSTEM_POLICY = [
  'You are the decision component of GPT Relay.',
  'Choose exactly one Decision Contract action from the supplied bounded state packet.',
  'Never expand delegated capabilities, writable paths, or authorization.',
  'COMPLETE is permitted only when the latest result is validated PASS and acceptance is met.',
  'Use ASK_HUMAN or REQUEST_APPROVAL when authority or required information is missing.',
  'Do not call tools and do not return prose outside the schema.'
].join(' ');

function outputText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  for (const item of response?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return null;
}

export class OpenAIDecisionProvider {
  id = 'openai-responses';
  model;
  #apiKey;
  #baseUrl;
  #timeoutMs;
  #maxRetries;
  #retryDelayMs;
  #fetch;

  constructor({
    apiKey,
    model = 'gpt-5.6',
    baseUrl = 'https://api.openai.com/v1',
    timeoutMs = 60_000,
    maxRetries = 2,
    retryDelayMs = 500,
    fetchImpl = globalThis.fetch
  } = {}) {
    if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('OpenAI decision provider requires apiKey');
    if (typeof fetchImpl !== 'function') throw new Error('OpenAI decision provider requires fetch');
    this.#apiKey = apiKey;
    this.model = model;
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#timeoutMs = timeoutMs;
    this.#maxRetries = Math.max(0, maxRetries);
    this.#retryDelayMs = Math.max(0, retryDelayMs);
    this.#fetch = fetchImpl;
  }

  async generate(packet) {
    const sanitized = redactSecrets(structuredClone(packet));
    const body = {
      model: this.model,
      store: false,
      instructions: SYSTEM_POLICY,
      input: JSON.stringify(sanitized),
      text: {
        format: {
          type: 'json_schema',
          name: 'gpt_relay_decision',
          strict: true,
          schema: DECISION_SCHEMA
        }
      }
    };

    let lastError;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('OpenAI decision request timed out')), this.#timeoutMs);
      timer.unref?.();
      try {
        const response = await this.#fetch(`${this.#baseUrl}/responses`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.#apiKey}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!response.ok) {
          const detail = await response.text();
          const error = new Error(`OpenAI Responses API returned ${response.status}: ${detail.slice(0, 500)}`);
          error.status = response.status;
          if ((response.status === 429 || response.status >= 500) && attempt < this.#maxRetries) {
            lastError = error;
            if (this.#retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#retryDelayMs));
            continue;
          }
          throw error;
        }
        const responseBody = await response.json();
        const text = outputText(responseBody);
        if (!text) throw new Error('OpenAI response did not contain output_text');
        let decision;
        try {
          decision = JSON.parse(text);
        } catch (error) {
          throw new Error(`OpenAI decision output was not JSON: ${error.message}`);
        }
        return {
          decision,
          response_id: responseBody.id ?? null,
          model: responseBody.model ?? this.model,
          usage: responseBody.usage ?? null
        };
      } catch (error) {
        lastError = error;
        if (error?.name === 'AbortError') throw new Error('OpenAI decision request timed out');
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error('OpenAI decision request failed');
  }
}
