# Agent Execution Flow

## Principle

Tasks define work. Agents execute work.

An Agent is an interchangeable execution platform, not a responsibility category.

## Standard Flow

1. The current agent analyzes the request and required capabilities.
2. Work is completed directly when the current agent has the capability and authorization.
3. ChatGPT creates an ACTIVE task only for missing or environment-specific capabilities.
4. The executor runs `agent-workflow doctor --json`, validates the task, and executes only the permitted scope.
5. The executor writes and stamps a result, then runs `agent-workflow validate handoff`.
6. PASS completion removes the ACTIVE task. BLOCKED preserves it and may continue with `task resume`.
7. ChatGPT reviews the result and decides the next action.

## Agent Independence

The same task may be executed by Codex, ZCode, Claude Code, DeepSeek Harness, or other compatible agents.

Execution platform does not change task semantics.
