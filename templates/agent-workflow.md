# Agent Handoff Protocol

## 1. Operating model

GitHub is the durable source of truth. ChatGPT is the orchestrator; Codex, ZCode, Claude Code, DeepSeek Harness, and other compatible agents are remote execution platforms.

The intended loop is:

```text
User request
  -> ChatGPT inspects/changes GitHub directly
  -> local or real-environment work remains
  -> ChatGPT commits ACTIVE_TASK.json
  -> user sends one short executor trigger
  -> executor performs the task and commits a Result Contract
  -> ChatGPT reads GitHub and continues
```

Do not create executor work for repository operations ChatGPT can already complete safely through GitHub.

## 2. Task authority

The machine-readable active task is:

`docs/agent-tasks/ACTIVE_TASK.json`

It is the only task authority. Executor names never grant permissions.

If the active task is missing or invalid, stop. Do not infer work from chat history, issues, old result reports, source code, or a previous executor's task.

The normal user-facing trigger is intentionally minimal:

```text
Execute ACTIVE_TASK.json according to Agent Workflow Protocol.
```

Project requirements must not be duplicated into the trigger.

## 3. Modes

- `IMPLEMENT` — implementation changes only inside `allowed_changes`.
- `TEST_ONLY` — validation/reporting only. Writable paths are limited to `docs/agent-results/**`.
- `REVIEW_ONLY` — inspection/reporting only. Writable paths are limited to `docs/agent-results/**`.

The Task Contract, not the executor, determines scope.

## 4. Source revision

Before executing, resolve `source_branch` and `source_commit` from the Task Contract and confirm the working copy matches the requested revision.

`source_commit: LATEST` means: after fetching/pulling according to repository policy, resolve and execute the current tip of `source_branch`, and record the exact SHA actually used in the Result Contract. This is the normal value for a queued task committed to the same branch because the task commit itself moves the branch tip.

Use an explicit commit SHA only when the orchestrator intentionally wants execution pinned to that immutable revision. Other explicitly documented symbolic values may be used when the project workflow defines their resolution semantics.

Do not silently reset, clean, stash, overwrite, or discard unrelated user changes.

## 5. Scope and safety

- Modify only paths authorized by `allowed_changes`.
- Treat `forbidden_changes` as hard prohibitions.
- Everything not authorized is read-only.
- `result_contract` must be inside `docs/agent-results/**` and must appear in `allowed_changes`.
- Never expose credentials, tokens, cookies, private keys, signed URLs, secret environment values, or sensitive local paths.
- Do not invent build, test, lint, typecheck, release, or project commands.
- Preserve dirty worktrees and unrelated changes.

## 6. Validation statuses

Use only:

`PASS`, `FAIL`, `PARTIAL`, `SKIP`, `BLOCKED`, `NOT RUN`

Never convert an unexecuted or blocked check into PASS.

## 7. Execution lifecycle

New execution results use **Result Contract v2** (`schema_version: 2`). Historical Result Contracts without `schema_version` are legacy v1 and remain valid; do not rewrite old reports only to upgrade their format.

1. Read this workflow.
2. Run `agent-workflow doctor --json`, then read and validate `docs/agent-tasks/ACTIVE_TASK.json`.
3. Confirm source revision and worktree safety.
4. Start a Result Contract v2 draft and record `timeline.started_at` at second precision with timezone when real task execution begins.
5. Execute only the authorized scope in the real environment.
6. Run every required validation or record why it is `BLOCKED`, `SKIP`, or `NOT RUN`.
7. Finish writing the Result Contract and record `timeline.completed_at` at second precision with timezone.
8. Run the installed Result validator with `--stamp` so the validator itself writes `result_validation` evidence:

   ```bash
   node .agent-workflow/validator/validate-contract.mjs result <result-json> --stamp
   ```

9. Run `agent-workflow validate handoff --task docs/agent-tasks/ACTIVE_TASK.json --result <result-json> --target .` and verify completion against `acceptance_criteria`. A new Result Contract v2 without stamped validator evidence is incomplete.
10. When completion is real and `delete_active_task_on_completion` is true, remove `ACTIVE_TASK.json` and its companion when required. A BLOCKED result is not completion: keep the task, then use `agent-workflow task resume` after the missing capability becomes available.
11. Commit/push only paths allowed by `completion_commit_contract` and repository policy.
12. Stop. Do not self-assign follow-up work.

`completion_commit_contract` must include the Result Contract and `docs/agent-tasks/ACTIVE_TASK.json`. If task metadata says a human companion was generated, include `docs/agent-tasks/ACTIVE_TASK.md` too.

## 8. Result handoff

New Result Contracts must include `schema_version: 2` and an auditable timeline:

```text
timeline.started_at
  -> local execution and required checks
  -> timeline.completed_at
  -> validator --stamp
  -> result_validation.validated_at
```

All three timestamps use ISO 8601 with year, month, day, hour, minute, second, and timezone, for example `2026-08-21T15:12:04+08:00`. Milliseconds are not used.

`result_validation` is validator-owned evidence. Executors must not manually claim validator success. The validator stamps `status: PASS`, the canonical command, the validation timestamp, and success evidence only after the v2 draft Result Contract passes validation; the stamped final document is then validated again before it is written.

Historical v1 Result Contracts, identified by the absence of `schema_version`, remain valid without v2 timeline/stamp fields so workflow upgrades do not invalidate prior evidence.

After execution, the user may simply tell ChatGPT that the executor is finished. ChatGPT should inspect GitHub directly, evaluate the result, and decide the next action.

`result_commit` may remain null. The commit containing the final Result is derived from Git history (`agent-workflow status --json`) instead of being written into the file that would need to identify itself.

## 9. Orchestrator boundary

ChatGPT should create an ACTIVE Task only for work it cannot actually complete through GitHub or that requires the user's real execution environment, credentials, devices, runtime, or release tooling.

Repository edits that ChatGPT can safely perform through GitHub should be performed directly rather than delegated by default.

## 10. Installation and removal

Workflow installation must not create an ACTIVE task. Workflow removal must be ownership-based using `docs/.agent-workflow-install.json` and must refuse to proceed while an ACTIVE task exists.
