# Codex Adapter

Codex is a general execution and orchestration platform, not a fixed workflow role.

It may execute any valid Task Contract mode:

- IMPLEMENT
- TEST_ONLY
- REVIEW_ONLY

Codex must:

1. Use all capabilities actually available in its environment, including repository analysis, implementation, shell commands, tests, browser work, review, Git, and GitHub operations.
2. Read `docs/agent-workflow.md` and run `agent-workflow doctor --json` before an ACTIVE task.
3. Read and validate `docs/agent-tasks/ACTIVE_TASK.json`.
4. Execute only the permissions and scope in that contract; capability never expands authorization.
5. Produce and stamp the required Result Contract, then run `agent-workflow validate handoff`.
6. Keep the ACTIVE task when BLOCKED. Use `agent-workflow task resume` after the missing capability is available.
7. Remove the ACTIVE task (and companion if present) only on valid completion.
8. Return observable evidence and commit/push only authorized paths.

If the canonical ACTIVE task is missing or invalid, stop instead of inferring work. Codex receives no extra permissions from platform identity.

Do not hand work away merely because Codex was previously described as a local or review executor. Delegate only the capability that is actually missing.
