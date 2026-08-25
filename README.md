# GPT Relay

GPT-first autonomous relay and durable workflow control plane.

GPT Relay keeps the primary GPT in charge of reasoning, planning, review, and acceptance. It delegates only a concrete capability gap to a compatible executor, persists the executor evidence, and automatically returns a bounded result packet for the next decision.

Current version: **2.0.0 foundation**

## What changed from Agent Workflow

`Ran-sh/chatgpt_workflow` v1.9 is retained as the compatible contract and installation layer. GPT Relay adds the runtime that the original repository intentionally did not have:

- SQLite-backed workflows, attempts, sessions, events, cursors, Attention, and artifacts;
- deterministic capability-gap matching, separate from authorization;
- canonical control-plane events with generation-aware idempotency and a durable outbox;
- trace/control lanes so tool progress does not wake GPT on every line;
- bounded state packets and typed decisions;
- same-session `FOLLOW_UP`, new-attempt `RETRY`, and validated `COMPLETE`;
- a Codex JSONL adapter with structured-terminal and resume identity checks;
- a runtime status / Attention / events CLI.

The legacy `agent-workflow` command remains available.

## Core loop

```text
objective
  -> required capabilities
  -> primary GPT capabilities
  -> concrete gap only
  -> deterministic executor match
  -> minimal delegated scope
  -> canonical events + evidence
  -> bounded GPT decision packet
  -> FOLLOW_UP / RETRY / COMPLETE / Attention
```

The runtime will not start an executor when the capability gap is empty. Capability says what an executor can do; Authorization says what this task allows it to do. They are never merged.

## Information-flow guarantees

The relay uses two lanes:

- `trace`: tool activity, streaming output, and progress. Stored for inspection, never a decision trigger by itself.
- `control`: state changes, terminal events, validated results, approvals, human replies, and capability changes.

Every canonical event is persisted before routing. Control events remain pending until delivery succeeds and can be drained after restart. Provider-native replays are deduplicated, while identical ID-less events from different attempts or generations remain distinct. Each executor session has a monotonic generation; events from an older generation are rejected. Oversized payloads become `artifact://` references, and credential-shaped data is redacted before persistence or GPT context construction.

See [docs/information-flow.md](docs/information-flow.md).

## Requirements

- Node.js 24 or newer (`node:sqlite` is used by the durable runtime)
- Git for legacy Task / Result handoffs
- Codex CLI only for real Codex execution; all core tests use protocol fixtures and do not call a model

Writable Codex jobs additionally require a trusted `workspaceBoundary` implementation. The adapter fails closed without one, filters credential-shaped environment variables when `authorization.credentials` is false, and never treats prompt text as a filesystem security boundary.

## Quick start

```bash
npm test
node bin/gpt-relay.mjs runtime init --db .gpt-relay/runtime.sqlite
node bin/gpt-relay.mjs runtime status --db .gpt-relay/runtime.sqlite
node bin/gpt-relay.mjs task validate-vnext examples/contracts/task-contract-vnext.example.json
```

Inspect open Attention and recent control events:

```bash
node bin/gpt-relay.mjs runtime attention --db .gpt-relay/runtime.sqlite
node bin/gpt-relay.mjs runtime events --db .gpt-relay/runtime.sqlite --workflow <workflow-run-id> --control-only
```

The programmatic runtime is composed from `WorkflowDaemon`, `SQLiteRuntimeStore`, `RelayPipeline`, `ExecutorRegistry`, an executor adapter, and a typed decision runner.

## Compatibility command

Existing installations and repositories can keep using:

```bash
node bin/agent-workflow.mjs install <target>
node bin/agent-workflow.mjs task create ...
node bin/agent-workflow.mjs validate task <file>
node bin/agent-workflow.mjs validate result <file>
node bin/agent-workflow.mjs task resume --target <target>
```

Task Contract vNext fields are additive. Legacy v1.9 contracts still validate unchanged.

## Project status

Implemented in the v2.0 foundation:

- contracts, authorization, capability gap, state transitions;
- durable event / attempt / session / Attention storage;
- event normalization, redaction, durable control outbox, generation-aware dedupe/fencing, artifact spill;
- FakeExecutor and deterministic registry;
- Codex non-interactive JSONL adapter;
- bounded state packet and automatic follow-up loop;
- runtime query CLI and vNext validation.

Next milestones are long-running service packaging, production GPT decision integration, ZCode/Claude adapters, external GitHub/webhook sources, and only later parallel barriers or a watch GUI. See [docs/roadmap.md](docs/roadmap.md).

## Reference projects

The implementation was informed by:

- [`Ran-sh/chatgpt_workflow`](https://github.com/Ran-sh/chatgpt_workflow), the imported v1.9 contract/install baseline;
- [`milind-soni/OpenMausBot`](https://github.com/milind-soni/OpenMausBot), especially its driver registry, normalized event bus, permission events, process ownership, fixture drivers, and bounded context work;
- the historical `dsh-vision` and `dsh-crew` evidence already documented by the source project.

The attachment named the project `OpenMausBoth`; the public repository is `OpenMausBot`. GPT Relay does not copy its desktop UI or source files. The borrowed ideas are documented in [docs/reference-projects.md](docs/reference-projects.md).

## Safety invariants

- No capability gap means no executor dispatch.
- Delegated capabilities and writable paths cannot exceed the parent Task Contract.
- A false Authorization flag cannot be overridden by executor readiness.
- Raw progress never directly triggers a GPT decision turn.
- A delivered duplicate event cannot create a duplicate action proposal; undelivered control events remain replayable.
- Writable executor work requires an enforceable workspace boundary supplied by the host.
- A stale session generation cannot mutate the active attempt.
- Exit code zero without a structured terminal event is failure.
- A resumed Codex thread must return the expected thread ID.
- `COMPLETE` requires a validated PASS result and satisfied acceptance criteria.
- Secrets and session references do not enter bounded GPT packets.

## License and attribution

This repository preserves the history of `Ran-sh/chatgpt_workflow`. OpenMausBot was reviewed as an Apache-2.0 reference; no OpenMausBot source file was copied into this implementation.
