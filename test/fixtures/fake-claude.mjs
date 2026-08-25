#!/usr/bin/env node

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('2.test (Claude Code)');
  process.exit(0);
}
const resumeIndex = args.indexOf('--resume');
const requested = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
const sessionId = process.env.FAKE_CLAUDE_SESSION_ID || requested || 'C-new';
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }));
console.log(JSON.stringify({
  type: 'result', subtype: process.env.FAKE_CLAUDE_FAIL ? 'error' : 'success',
  is_error: Boolean(process.env.FAKE_CLAUDE_FAIL), result: 'Claude completed',
  session_id: sessionId, total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 2 }
}));
const exitCode = process.env.FAKE_CLAUDE_FAIL ? 1 : 0;
const delayExitMs = Number(process.env.FAKE_CLAUDE_DELAY_EXIT_MS ?? 0);
if (Number.isFinite(delayExitMs) && delayExitMs > 0) {
  setTimeout(() => process.exit(exitCode), delayExitMs);
} else {
  process.exit(exitCode);
}
