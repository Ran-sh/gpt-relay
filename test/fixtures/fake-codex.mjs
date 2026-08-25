#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('codex-cli 0.test');
  process.exit(0);
}

if (process.env.FAKE_CODEX_MODE === 'invalid-json') {
  console.log('this is not json');
  process.exit(0);
}

const resumeIndex = args.indexOf('resume');
const requestedThread = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
const threadId = process.env.FAKE_CODEX_THREAD_ID || requestedThread || 'S-new';

console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: { id: 'item-1', type: 'agent_message', text: 'Tests finished with evidence.' }
}));

if (process.env.FAKE_CODEX_MODE === 'fail') {
  console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'test failed' } }));
  process.exit(1);
}

console.log(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 7 }
}));
