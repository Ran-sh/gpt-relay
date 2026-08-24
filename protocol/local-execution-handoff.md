# Local Execution Handoff

## When ChatGPT should hand work to a remote executor

Create an ACTIVE Task only when a meaningful part of the work cannot be completed with the current agent's available and authorized repository, shell, browser, GitHub, credential, device, or real-environment capabilities.

Typical handoff cases include:

- compiling, testing, benchmarking, or reproducing behavior on the user's machine;
- running a real application, GUI, plugin host, device, browser profile, GPU, or platform-specific environment;
- using local files or uncommitted workspace state that GitHub cannot access;
- exercising credentials, provider configuration, accounts, signing keys, package registries, stores, or release tools that are intentionally not available to ChatGPT;
- publishing or deployment steps that require local authorization or interactive tooling;
- runtime validation whose truth cannot be established from repository contents alone.

## When ChatGPT should not hand off

Do not create an ACTIVE Task merely because an external executor could also do the work.

If ChatGPT can safely complete the repository change with GitHub and verify the repository state, it should do so directly and continue.

This keeps the workflow short:

```text
GitHub-capable work -> ChatGPT does it
Real-environment work -> ACTIVE_TASK.json -> executor
Result -> GitHub -> ChatGPT continues
```

## Handoff requirements

Before the user is asked to trigger an executor, the orchestrator must already have committed a valid `docs/agent-tasks/ACTIVE_TASK.json` containing:

- exact objective and context;
- mode;
- source branch and revision;
- allowed and forbidden changes;
- required validation;
- acceptance criteria;
- Result Contract path;
- completion commit contract.

The trigger must not repeat these details.

## Completion

Before completion, the executor runs `agent-workflow validate handoff`. A BLOCKED result keeps the ACTIVE task and becomes a resumable checkpoint; it is not deleted and recreated. After the executor finishes, ChatGPT should read the Result Contract and relevant commit/PR directly from GitHub. The user should normally need to send only a short completion signal such as:

```text
Codex finished. Check GitHub.
```

If the result is incomplete or blocked, ChatGPT decides whether to modify the repository, issue a narrower follow-up task, or request a genuinely necessary user decision.
