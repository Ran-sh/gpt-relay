import assert from 'node:assert/strict';
import test from 'node:test';

import { AuditedDecisionRunner } from '../lib/orchestrator/audited-decision-runner.mjs';
import { OpenAIDecisionProvider } from '../lib/orchestrator/openai-decision-provider.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
}

test('OpenAI decision provider uses strict Responses structured output and retries 429', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    if (requests.length === 1) return response(429, { error: { message: 'rate limited' } });
    return response(200, {
      id: 'resp_test',
      model: 'gpt-5.6',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        decision: 'WAIT', reason: 'Await durable input'
      }) }] }],
      usage: { input_tokens: 10, output_tokens: 5 }
    });
  };
  const provider = new OpenAIDecisionProvider({
    apiKey: 'sk-private-value', model: 'gpt-5.6', fetchImpl, maxRetries: 1, retryDelayMs: 0
  });
  const result = await provider.generate({ workflow: { run_id: 'W-1' }, api_key: 'sk-packet-secret-value' });
  assert.equal(result.decision.decision, 'WAIT');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(requests[0].body.store, false);
  assert.equal(requests[0].body.text.format.type, 'json_schema');
  assert.equal(requests[0].body.text.format.strict, true);
  assert.doesNotMatch(JSON.stringify(requests[0].body), /sk-packet-secret/);
  assert.equal(requests[0].init.headers.Authorization, 'Bearer sk-private-value');
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 });
});

test('audited decision runner validates output and persists hashes without secrets', async (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  const runner = new AuditedDecisionRunner({
    store,
    provider: {
      id: 'fixture-provider', model: 'fixture-model',
      async generate() {
        return { decision: { decision: 'WAIT', reason: 'Hold' }, response_id: 'resp_fixture', usage: { total_tokens: 4 } };
      }
    },
    idFactory: () => 'D-audit'
  });
  const decision = await runner.decide({
    workflow: { run_id: 'W-audit' },
    attempt: { attempt_id: 'A-audit' },
    authorization: { credentials: false },
    api_key: 'sk-do-not-store-this-value'
  });
  assert.equal(decision.decision, 'WAIT');
  const audit = store.getDecisionAudit('D-audit');
  assert.equal(audit.status, 'VALID');
  assert.equal(audit.provider, 'fixture-provider');
  assert.match(audit.packet_hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(audit), /sk-do-not-store/);
});
