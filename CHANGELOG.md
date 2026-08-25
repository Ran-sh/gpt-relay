# Changelog

## 2.0.0

- Renamed the primary package and command to GPT Relay while retaining the legacy `agent-workflow` CLI.
- Added capability-gap delegation with separately enforced Authorization and bounded Delegated Scope Contracts.
- Added a durable SQLite runtime for workflows, immutable attempts, executor sessions, canonical events, cursors, Attention, and artifacts.
- Added trace/control event lanes, an ordered durable outbox, workflow/attempt/generation-scoped identity, exact generation fencing, secret redaction, and artifact spill.
- Added an executor registry, FakeExecutor scenarios, and a Codex JSONL adapter with structured-terminal, resume-session, minimal-environment, and isolated-copy workspace enforcement.
- Added persisted PID reconciliation that converges lost sessions, attempts, workflows, and Attention after daemon restart.
- Added bounded state packets, typed decisions, validated completion gates, and same-session automatic follow-up.
- Added runtime status, Attention, event inspection, and vNext Task validation commands.
- Documented the OpenMausBot assessment and agent information-flow optimization.

## 1.9.0

- Changed delegation from agent-name roles to capability-based execution; Codex may directly perform repository, implementation, test, browser, Git, GitHub, and real-environment work when available and authorized.
- Added canonical managed-path validation that rejects traversal, drive-qualified, UNC, and unsafe path forms across task creation and validation.
- Added `agent-workflow doctor` and `status` machine-readable control-plane commands.
- Added `validate handoff` to cross-check Task and Result identity, result path, source revision, and changed-file scope.
- Added resumable BLOCKED attempts. The ACTIVE task and prior Result are preserved; `task resume` opens a numbered result path.
- Clarified that `result_commit: null` is normal and eliminated the self-referential follow-up-commit expectation.
- Added evidence-backed findings from `dsh-vision` and `dsh-crew` to keep real failure modes in the source workflow.

## 1.8.0

- Refocused the workflow on ChatGPT as the GitHub-side orchestrator and Codex/ZCode/Claude Code/DeepSeek Harness as interchangeable remote executors.
- Added the explicit orchestrator/executor boundary and local-execution handoff rules.
- Standardized the user-facing executor trigger to a short repository/branch/task-file handoff instead of duplicating task details in chat.
- Changed generated queued tasks to use `source_commit: LATEST` by default, with explicit SHA pinning still available for immutable execution.
- Added `metadata.prepared_from_commit` to preserve the task-preparation baseline for audit.
- Added Result Contract v2 with `schema_version: 2`, second-precision timezone-aware execution timelines, and validator-owned `result_validation` evidence.
- Added `validator --stamp`, which validates a draft result, writes PASS/command/validated_at/evidence itself, then validates the stamped final contract before writing it.
- Preserved backward compatibility for legacy Result Contract v1 files without `schema_version`; historical results remain valid and do not need rewriting.
- Added regression coverage for queued task source semantics, Result v2 stamping, timestamp precision/order, and legacy v1 compatibility.
- Simplified the README around the actual user experience: ChatGPT changes GitHub, remote executor performs real local work, Result Contract returns to GitHub, ChatGPT continues.
- Verified the full workflow end to end on `Ran-sh/dsh-vision`, including real local execution, Result v2 timeline evidence, validator stamping, legacy v1 validation, and ACTIVE task cleanup.

## 1.7.0

- Added `agent-workflow task create` for non-interactive, machine-readable ACTIVE Task generation.
- Added automatic Git source branch/commit detection with explicit override flags.
- Added safe mode behavior: `IMPLEMENT` requires explicit writable scope; `TEST_ONLY` and `REVIEW_ONLY` default writable scope to the Result Contract only.
- Added generated Task validation before activation and refusal to overwrite an existing ACTIVE task.
- Added optional non-authoritative `ACTIVE_TASK.md` human companion.
- Added schema-valid `TEMPLATE_TASK.json` and install support for the machine task scaffold.
- Unified all executor triggers on `docs/agent-tasks/ACTIVE_TASK.json`; removed executor-specific ACTIVE task naming from canonical triggers.
- Strengthened the project workflow protocol around authority, source revisions, scope, dirty worktrees, validation statuses, result handoff, and executor neutrality.
- Added uninstall blocking when an ACTIVE task is present and verification that the ownership manifest identifies this workflow source.
- Expanded lifecycle tests for task generation, duplicate-task protection, IMPLEMENT scope requirements, and uninstall safety.

## 1.6.0

- Added executable zero-dependency `agent-workflow` CLI.
- Added `install`, `validate task`, `validate result`, and `uninstall` commands.
- Added conservative project detection for language, package manager, configured package scripts, and GitHub Actions files.
- Added ownership-based installation manifest with `generated_files` and `generated_dirs`.
- Added lifecycle smoke tests that verify install/validate/uninstall behavior and preservation of pre-existing project content.
- Updated CI to exercise the CLI and check version consistency.
- Removed the executor-specific DeepSeek Harness task template; executor choice is no longer encoded as a task type.
- Added platform-neutral task-template README and aligned install/uninstall documentation with the machine-readable ownership contract.

## 1.5.0

- Added machine-readable Task and Result contracts.
- Added canonical zero-dependency contract validation.
- Added installation/removal guidance and ownership-manifest concepts.
- Added agent-neutral executor adapters and reference examples.
