const OUTPUT_TYPES = Object.freeze([
  'approval.granted',
  'approval.denied',
  'github.ci_failed',
  'github.pr_updated',
  'task.resumed',
  'unknown',
  'ignore'
]);

export const SEMANTIC_CLASSIFIER_TYPES = new Set(OUTPUT_TYPES);

const NEGATED_DENIAL = /(?:\b(?:do\s+not|don't|never)\s+(?:deny|reject|decline)\b|不(?:要)?(?:拒绝|驳回))/iu;
const NEGATED_GRANT = /(?:\b(?:do\s+not|don't|never)\s+(?:approve|grant|authorize)\b|不(?:要|予|会|能)?(?:批准|同意|授权))/iu;
const EXPLICIT_GRANT = /(?:^|[.!]\s*)(?:i\s+)?(?:approve|grant|authorize)\b|^(?:我|本人)?(?:批准|同意|授权)/iu;
const EXPLICIT_DENIAL = /(?:^|[.!]\s*)(?:i\s+)?(?:deny|reject|decline)\b|^(?:我|本人)?(?:拒绝|驳回|不同意)/iu;

function approvalSignal(text) {
  const negatedDenial = NEGATED_DENIAL.test(text);
  const mentionsGrant = /\b(?:approve|grant|authorize)\b|(?:批准|同意|授权)/iu.test(text);
  const mentionsDenial = /\b(?:deny|reject|decline)\b|(?:拒绝|驳回|不同意)/iu.test(text);
  const denied = EXPLICIT_DENIAL.test(text) || NEGATED_GRANT.test(text);
  const granted = EXPLICIT_GRANT.test(text);

  if (negatedDenial) return 'unknown';
  if (mentionsGrant && mentionsDenial) return 'unknown';
  if (granted && denied) return 'unknown';
  if (denied) return 'approval.denied';
  if (granted) return 'approval.granted';
  return null;
}

function operationalSignal(text) {
  const ciSubject = /\b(?:ci|build|workflow|test(?:s|ing)?)\b|(?:CI|构建|工作流|测试)/iu.test(text);
  const failure = /\b(?:failed|failure|failing|broken)\b|(?:失败|未通过|异常)/iu.test(text);
  if (ciSubject && failure) return 'github.ci_failed';

  const pullRequest = /\b(?:pull\s+request|pr)\b|(?:合并请求)/iu.test(text);
  const updated = /\b(?:updated|changed|synchronized|new\s+commits?)\b|(?:已?更新|有变更|新提交)/iu.test(text);
  if (pullRequest && updated) return 'github.pr_updated';

  const resume = /\b(?:resume|continue)\b|(?:继续|恢复)/iu.test(text);
  const task = /\b(?:task|workflow|job|work)\b|(?:任务|工作流|作业)/iu.test(text);
  if (resume && task && !/(?:\b(?:do\s+not|don't|never)\s+(?:resume|continue)\b|不要(?:继续|恢复))/iu.test(text)) {
    return 'task.resumed';
  }
  return null;
}

export class SemanticClassifier {
  #maxLength;

  constructor({ maxLength = 4_096 } = {}) {
    if (!Number.isSafeInteger(maxLength) || maxLength < 32) throw new RangeError('maxLength must be an integer of at least 32');
    this.#maxLength = maxLength;
  }

  classify(input) {
    if (typeof input !== 'string') return 'unknown';
    const text = input.trim().replace(/\s+/gu, ' ');
    if (text.length === 0) return 'ignore';
    if (text.length > this.#maxLength) return 'unknown';

    const approval = approvalSignal(text);
    if (approval) return approval;
    const operational = operationalSignal(text);
    if (operational) return operational;
    if (/^(?:heartbeat|ping|pong)\b|(?:\b\d{1,3}%\s+complete\b)|^(?:心跳|进度)[:：\s]/iu.test(text)) return 'ignore';
    return 'unknown';
  }
}
