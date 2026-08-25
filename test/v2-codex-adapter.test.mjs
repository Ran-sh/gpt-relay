import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildChildEnvironment, CodexAdapter, renderCodexPrompt } from '../lib/executors/codex.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

function task() {
  return {
    id: 'T-204',
    objective: 'Finish the release',
    required_capabilities: ['local.shell', 'local.test'],
    allowed_changes: ['docs/agent-results/T-204.json'],
    forbidden_changes: ['src/**'],
    delegated_scope: {
      objective: 'Run npm test and report exact failures',
      required_capabilities: ['local.shell', 'local.test'],
      allowed_changes: ['docs/agent-results/T-204.json'],
      forbidden_changes: ['src/**'],
      validation: ['npm test'],
      return: ['exit_status', 'test_output', 'artifacts']
    },
    authorization: {
      shell: true,
      network: false,
      browser_login: false,
      credentials: false,
      git_commit: false,
      git_push: false,
      publish: false,
      deploy_production: false,
      destructive_operations: false
    }
  };
}

async function collectEvents(adapter, handle) {
  const events = [];
  for await (const event of adapter.events(handle)) events.push(event);
  return events;
}

const testBoundary = {
  async prepare({ cwd }) {
    return { cwd, async finalize() {} };
  }
};

test('Codex prompt contains only the delegated scope and a bounded handoff', () => {
  const prompt = renderCodexPrompt(task(), {
    handoff: 'Previous attempt: one Windows test failed.',
    parentConversation: 'PRIVATE FULL CONVERSATION THAT MUST NOT LEAK'
  });

  assert.match(prompt, /Run npm test and report exact failures/);
  assert.match(prompt, /Previous attempt: one Windows test failed/);
  assert.match(prompt, /git_push.*false/);
  assert.doesNotMatch(prompt, /PRIVATE FULL CONVERSATION/);
  assert.doesNotMatch(prompt, /Finish the release/);
});

test('CodexAdapter detects the CLI and collects structured terminal evidence', async () => {
  const adapter = new CodexAdapter({ cli: process.execPath, cliArgs: [fixture], workspaceBoundary: testBoundary });
  assert.deepEqual(await adapter.detect(), {
    ready: true,
    reason: null,
    version: 'codex-cli 0.test'
  });

  const handle = await adapter.start(task(), {
    cwd: process.cwd(),
    workflow_run_id: 'W-1',
    attempt_id: 'A-1'
  });
  const events = await collectEvents(adapter, handle);
  const result = await adapter.collectResult(handle);

  assert.deepEqual(events.map((event) => event.type), [
    'thread.started', 'turn.started', 'item.completed', 'turn.completed'
  ]);
  assert.equal(result.status, 'PASS');
  assert.equal(result.session_id, 'S-new');
  assert.equal(result.exit_status, 0);
  assert.equal(result.summary, 'Tests finished with evidence.');
  assert.deepEqual(result.usage, { input_tokens: 12, cached_input_tokens: 2, output_tokens: 7 });
  assert.ok(handle.args.includes('--json'));
  assert.ok(handle.args.includes('workspace-write'));
});

test('CodexAdapter rejects exit-zero output without a structured terminal event', async () => {
  const adapter = new CodexAdapter({
    cli: process.execPath,
    cliArgs: [fixture],
    environment: { FAKE_CODEX_MODE: 'invalid-json' },
    workspaceBoundary: testBoundary
  });
  const handle = await adapter.start(task(), { cwd: process.cwd() });
  const events = await collectEvents(adapter, handle);
  const result = await adapter.collectResult(handle);

  assert.equal(events.at(-1).type, 'executor.failed');
  assert.equal(result.status, 'FAIL');
  assert.match(result.summary, /invalid structured output/i);
});

test('CodexAdapter fails closed when resume returns a different thread', async () => {
  const adapter = new CodexAdapter({
    cli: process.execPath,
    cliArgs: [fixture],
    environment: { FAKE_CODEX_THREAD_ID: 'S-unexpected' },
    workspaceBoundary: testBoundary
  });
  const handle = await adapter.resume(
    { session_id: 'S-expected' },
    task(),
    { cwd: process.cwd(), handoff: 'Run only the remaining test.' }
  );
  await collectEvents(adapter, handle);
  const result = await adapter.collectResult(handle);

  assert.equal(result.status, 'FAIL');
  assert.equal(result.session_lost, true);
  assert.match(result.summary, /expected S-expected.*received S-unexpected/);
});

test('CodexAdapter fails closed when writable scope lacks an enforceable boundary', async () => {
  const adapter = new CodexAdapter({ cli: process.execPath, cliArgs: [fixture], workspaceBoundary: null });
  await assert.rejects(
    adapter.start(task(), { cwd: process.cwd() }),
    /enforceable workspace boundary/
  );
});

test('child environment removes credentials when authorization denies them', () => {
  const childEnvironment = buildChildEnvironment(task(), {
    PATH: 'safe-path',
    OPENAI_API_KEY: 'secret',
    GITHUB_TOKEN: 'secret',
    CUSTOM_VALUE: 'kept'
  }, { FAKE_CODEX_MODE: 'test', API_TOKEN: 'secret' });

  assert.equal(childEnvironment.PATH, 'safe-path');
  assert.equal(childEnvironment.CUSTOM_VALUE, undefined);
  assert.equal(childEnvironment.FAKE_CODEX_MODE, 'test');
  assert.equal(childEnvironment.OPENAI_API_KEY, undefined);
  assert.equal(childEnvironment.GITHUB_TOKEN, undefined);
  assert.equal(childEnvironment.API_TOKEN, undefined);
});
