import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  assertRuntimeResultContract,
  isManagedResultPath
} from '../contracts/result.mjs';

function timestamp(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function ensureManagedDirectory(workspace, relativePath) {
  const root = realpathSync(workspace);
  let current = root;
  for (const segment of path.posix.dirname(relativePath).split('/')) {
    current = path.join(current, segment);
    if (!existsSync(current)) mkdirSync(current);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('result path must remain in a real workspace directory');
    }
  }
  return { root, directory: current };
}

function buildContract(input, now) {
  const resultPath = input?.task?.result_contract;
  if (!isManagedResultPath(resultPath)) {
    throw new Error('task.result_contract must be inside docs/agent-results/**');
  }
  const instant = timestamp(now());
  return assertRuntimeResultContract({
    status: input.status,
    summary: input.summary,
    task_id: input.task?.id,
    result_path: resultPath,
    timeline: input.timeline ?? { started_at: instant, completed_at: instant },
    tests: input.tests ?? [],
    blockers: input.blockers ?? [],
    artifacts: input.artifacts ?? [],
    evidence: input.evidence ?? []
  });
}

export class ResultContractService {
  #workspace;
  #now;

  constructor({ workspace, now = () => new Date() } = {}) {
    if (typeof workspace !== 'string' || workspace.length === 0) {
      throw new Error('ResultContractService requires workspace');
    }
    this.#workspace = path.resolve(workspace);
    this.#now = now;
  }

  build(input) {
    return buildContract(input, this.#now);
  }

  write(input) {
    const contract = this.build(input);
    const relativePath = contract.result_path;
    const { root, directory } = ensureManagedDirectory(this.#workspace, relativePath);
    const target = path.join(root, ...relativePath.split('/'));
    const relativeTarget = path.relative(root, target);
    if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
      throw new Error('result path escaped workspace');
    }
    const content = `${JSON.stringify(contract, null, 2)}\n`;
    if (existsSync(target)) return this.#existing(target, content, contract);

    const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, content, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try {
        linkSync(temporary, target);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        return this.#existing(target, content, contract);
      }
      return { status: 'written', path: target, contract };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  #existing(target, content, contract) {
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error('result contract conflict: target is a symbolic link');
    }
    if (readFileSync(target, 'utf8') !== content) {
      throw new Error(`result contract conflict at ${contract.result_path}`);
    }
    return { status: 'unchanged', path: target, contract };
  }
}
