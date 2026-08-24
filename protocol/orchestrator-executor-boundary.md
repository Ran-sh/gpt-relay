# Orchestrator / Remote Executor Boundary

## Goal

This workflow makes ChatGPT the durable task orchestrator while capable agents such as Codex can directly perform repository, shell, test, browser, Git, GitHub, and real-environment work available to them.

The operating model is:

```text
User request
  -> ChatGPT inspects and changes GitHub directly when it can
  -> ChatGPT creates ACTIVE_TASK.json only for work it cannot complete through GitHub
  -> User sends one short trigger to any compatible executor
  -> Executor performs the local/real-environment work
  -> Executor commits the Result Contract and allowed outputs
  -> ChatGPT reads GitHub, evaluates the result, and continues
```

## ChatGPT / Orchestrator responsibilities

The orchestrator owns project direction and the handoff loop. It should:

1. inspect current repository state before deciding what to do;
2. make repository changes directly through GitHub when those changes can be completed and verified there;
3. avoid creating an executor task for work that the orchestrator can already finish through GitHub;
4. create a precise Task Contract when real local execution is required;
5. place all task detail, permissions, validations, acceptance criteria, and result requirements in `docs/agent-tasks/ACTIVE_TASK.json`;
6. review the committed Result Contract and repository changes after the executor finishes;
7. continue the next GitHub-side change or create the next Task Contract without asking the user to relay long reports manually.

The orchestrator is the decision-maker. Executors must not self-assign follow-up work, but they should use all capabilities already available and authorized instead of creating unnecessary handoffs.

## Remote Executor responsibilities

Codex, ZCode, Claude Code, DeepSeek Harness, and future compatible executors are interchangeable execution platforms.

An executor should:

1. read the repository workflow;
2. read and validate `docs/agent-tasks/ACTIVE_TASK.json`;
3. execute exactly the authorized task in the real environment available to it;
4. write the required Result Contract/report;
5. commit/push only paths authorized by the Task Contract;
6. run joint handoff validation before completion;
7. keep the ACTIVE task when blocked and stop at the recorded checkpoint.

Executor identity never grants permissions and never determines task mode.

## Minimal user interaction

The user should not need to copy task details into chat with an executor. Once ChatGPT has committed the Task Contract, the normal user message is only:

```text
Execute ACTIVE_TASK.json according to Agent Workflow Protocol.
```

Everything else belongs in GitHub.

## Source of truth

- GitHub stores the durable project state.
- `docs/agent-tasks/ACTIVE_TASK.json` stores the current execution request.
- The Result Contract stores observable execution evidence.
- ChatGPT reads those artifacts and decides the next step.

Chat messages are triggers and completion signals, not substitutes for the repository contract.
