import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SemanticClassifier,
  SEMANTIC_CLASSIFIER_TYPES
} from '../lib/relay/semantic-classifier.mjs';
import { RelayPipeline } from '../lib/relay/pipeline.mjs';
import { SQLiteRuntimeStore } from '../lib/runtime/sqlite-store.mjs';

test('semantic classifier conservatively recognizes unambiguous English and Chinese signals', () => {
  const classifier = new SemanticClassifier();

  assert.equal(classifier.classify('CI build failed on the release branch'), 'github.ci_failed');
  assert.equal(classifier.classify('工作流运行失败，请查看日志'), 'github.ci_failed');
  assert.equal(classifier.classify('Pull request was updated with two commits'), 'github.pr_updated');
  assert.equal(classifier.classify('合并请求已更新'), 'github.pr_updated');
  assert.equal(classifier.classify('Please resume the paused task'), 'task.resumed');
  assert.equal(classifier.classify('继续之前暂停的任务'), 'task.resumed');
});

test('semantic classifier handles denial, negation, conflicts, and non-action chatter safely', () => {
  const classifier = new SemanticClassifier();

  assert.equal(classifier.classify('I approve this request'), 'approval.granted');
  assert.equal(classifier.classify('我同意这次授权'), 'approval.granted');
  assert.equal(classifier.classify('I deny this request'), 'approval.denied');
  assert.equal(classifier.classify('不要批准这个请求'), 'approval.denied');
  assert.equal(classifier.classify('Do not deny this request'), 'unknown');
  assert.equal(classifier.classify('Approve and deny this request'), 'unknown');
  assert.equal(classifier.classify('同意，但也拒绝这次授权'), 'unknown');
  assert.equal(classifier.classify('Could somebody approve this later?'), 'unknown');
  assert.equal(classifier.classify('heartbeat 42% complete'), 'ignore');
  assert.equal(classifier.classify('   '), 'ignore');
});

test('semantic classifier fails closed for invalid and oversized input and returns only its whitelist', () => {
  const classifier = new SemanticClassifier({ maxLength: 64 });
  const values = [
    classifier.classify(null),
    classifier.classify({ text: 'approve' }),
    classifier.classify(`approve ${'x'.repeat(64)}`),
    classifier.classify('unrecognized free-form message')
  ];

  assert.deepEqual(values, ['unknown', 'unknown', 'unknown', 'unknown']);
  for (const value of values) assert.ok(SEMANTIC_CLASSIFIER_TYPES.has(value));
  assert.equal(typeof classifier.dispatch, 'undefined');
  assert.equal(typeof classifier.action, 'undefined');
});

test('relay records semantic fallback without routing natural-language approval as an action', async (t) => {
  const store = new SQLiteRuntimeStore(':memory:');
  t.after(() => store.close());
  let routes = 0;
  const pipeline = new RelayPipeline({
    store,
    classifier: new SemanticClassifier(),
    route: async () => { routes += 1; }
  });

  const accepted = await pipeline.accept({
    id: 'NL-1', type: 'natural_language', payload: { text: 'I approve this request' }
  }, { workflow_run_id: 'W-semantic', source: 'chat' });

  assert.equal(accepted.status, 'stored_trace');
  assert.equal(accepted.event.payload.semantic_type, 'approval.granted');
  assert.equal(routes, 0);
});
