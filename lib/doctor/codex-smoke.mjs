import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function smokeTask() {
  return {
    id: 'T-codex-smoke',
    objective: 'Verify the Codex executor protocol without changing files',
    required_capabilities: ['local.shell'],
    allowed_changes: [],
    forbidden_changes: ['**'],
    delegated_scope: {
      objective: 'Return exactly SMOKE_OK without running network requests or changing files',
      required_capabilities: ['local.shell'],
      allowed_changes: [],
      forbidden_changes: ['**'],
      validation: [],
      return: ['exit_status', 'summary']
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

export async function runCodexSmoke({ adapter, live = false, timeoutMs = 30_000 } = {}) {
  if (!adapter) throw new Error('Codex smoke requires an adapter');
  const detection = await adapter.detect();
  if (!live || !detection.ready) {
    return { live: false, ready: detection.ready, reason: detection.reason ?? null, version: detection.version ?? null };
  }

  const workspace = mkdtempSync(path.join(tmpdir(), 'gpt-relay-codex-smoke-'));
  let handle;
  let timer;
  try {
    handle = await adapter.start(smokeTask(), {
      cwd: workspace,
      workspace_id: 'codex-smoke',
      workflow_run_id: 'W-codex-smoke',
      attempt_id: 'A-codex-smoke',
      generation: 1
    });
    const consume = (async () => {
      for await (const _event of adapter.events(handle)) {
        // Protocol consumption is the smoke evidence; progress is intentionally ignored.
      }
      return adapter.collectResult(handle);
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Codex smoke timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([consume, timeout]);
    return { live: true, ready: true, ...result };
  } catch (error) {
    if (handle) await adapter.cancel?.(handle);
    throw error;
  } finally {
    clearTimeout(timer);
    rmSync(workspace, { recursive: true, force: true });
  }
}
