# Reference Project Findings

This release was derived from the committed workflow history in `Ran-sh/dsh-vision` and `Ran-sh/dsh-crew`.

## Observed outcomes

- `dsh-vision`: 21 Result Contracts — 10 PASS, 9 PARTIAL, 1 FAIL, 1 BLOCKED.
- `dsh-crew`: 28 Result Contracts — 15 PASS, 13 BLOCKED.
- In `dsh-vision`, 120 of 396 commits touched workflow infrastructure, tasks, or results; `ACTIVE_TASK.json` changed 59 times.
- In `dsh-crew`, roughly 32 task-queue commits and 32 result commits show repeated queue/block/requeue overhead.

These counts are a historical snapshot used to identify failure modes, not a product-quality score.

## Repeated failure modes

1. Contracts were structurally valid but not checked against each other or the actual changed-file scope.
2. Credentials, browser state, provider routes, package-manager policy, or real-machine prerequisites were discovered only after expensive validation had started.
3. BLOCKED tasks were deleted and recreated, losing a first-class resume state and producing many bookkeeping commits.
4. `result_commit` attempted to refer to the commit containing the result itself, causing follow-up commits or remaining null.
5. Release gates validated one build state while publication could use a different worktree or artifact. `dsh-vision` consequently published defective 0.2.0 packages and required a 0.2.1 remediation.
6. Large all-or-nothing tasks collapsed many passing checks into a single BLOCKED/PARTIAL outcome.
7. Installed workflow snapshots, legacy executor-specific templates, and current documentation drifted apart.

## v1.9 response

- Reject unsafe managed paths before task activation and during validation.
- Add read-only `doctor` and `status` control-plane commands for Codex and other agents.
- Add Task/Result handoff cross-validation.
- Preserve BLOCKED evidence and resume through numbered attempts.
- Treat the Git-observed result commit as authoritative; `result_commit: null` is normal.
- Delegate by capability and authorization, allowing Codex to perform all work its actual environment supports.

Future work should add immutable release-artifact promotion, structured validation steps, capability manifests, installed-workflow upgrades, and multi-task dependency/lease support.
