# GPT Relay

GPT-first autonomous relay and durable workflow control plane.

GPT Relay keeps the primary GPT in charge of reasoning, planning, review, and acceptance. It delegates only a concrete capability gap to a compatible executor, persists the executor evidence, and automatically returns a bounded result packet for the next decision.

Current version: **2.5.0**

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
- audited OpenAI Responses API decisions, durable service leases/jobs, and restart continuation;
- Claude Code plus Codex executors, filesystem/Git/GitHub sources, notifications, DAG barriers, remote runners, schedules, and a read-only Watch API.
- persistent source/config registries, a production RuntimeHost, scoped permission resume, atomic Result Contracts, signed GitHub HTTP ingress, SSE Watch, semantic fallback, and scheduled-task CLI.

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

Writable Codex jobs run in the built-in isolated-copy boundary, which excludes Git/runtime metadata and applies only authorized output paths back to the source workspace. A host may replace this with a stronger `workspaceBoundary`; explicitly disabling the boundary fails closed. When `authorization.credentials` is false, the child receives a minimal environment plus an isolated home/profile, rather than the parent credential environment.

## Quick start

```bash
npm test
node bin/gpt-relay.mjs runtime init --db .gpt-relay/runtime.sqlite
node bin/gpt-relay.mjs runtime status --db .gpt-relay/runtime.sqlite
node bin/gpt-relay.mjs task validate-vnext examples/contracts/task-contract-vnext.example.json
node bin/gpt-relay.mjs doctor codex
```

Inspect open Attention and recent control events:

```bash
node bin/gpt-relay.mjs runtime attention --db .gpt-relay/runtime.sqlite
node bin/gpt-relay.mjs runtime events --db .gpt-relay/runtime.sqlite --workflow <workflow-run-id> --control-only
```

Start one durable worker after setting `OPENAI_API_KEY`:

```bash
node bin/gpt-relay.mjs source scan-file examples/contracts/task-contract-vnext.example.json --db .gpt-relay/runtime.sqlite
node bin/gpt-relay.mjs service start --db .gpt-relay/runtime.sqlite
```

Configure persistent sources, schedules, GitHub ingress, and Watch:

```bash
node bin/gpt-relay.mjs source add-file tasks docs/agent-tasks/T-104.json --db .gpt-relay/runtime.sqlite
node bin/gpt-relay.mjs source add-github github-main --secret-env GITHUB_WEBHOOK_SECRET --workflow W-T-104 --db .gpt-relay/runtime.sqlite
node bin/gpt-relay.mjs ingress github --db .gpt-relay/runtime.sqlite
node bin/gpt-relay.mjs watch serve --db .gpt-relay/runtime.sqlite
node bin/gpt-relay.mjs schedule add nightly --every-ms 86400000 --task docs/agent-tasks/T-104.json --db .gpt-relay/runtime.sqlite
```

The worker uses a single-writer lease, recovers running jobs on clean shutdown, resumes persisted checkpoints after human/approval input, and sends only bounded decision packets to the model.

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

Implemented through v2.5:

- contracts, authorization, capability gap, state transitions;
- durable event / attempt / session / Attention storage;
- event normalization, redaction, durable control outbox, generation-aware dedupe/fencing, artifact spill;
- FakeExecutor and deterministic registry;
- Codex non-interactive JSONL adapter;
- bounded state packet and automatic follow-up loop;
- runtime query/operator/service CLI and vNext validation;
- audited production decisions, durable job/lease recovery, notifications and observers;
- Claude/Codex adapters, signed GitHub deliveries, DAG barriers, remote runners, schedules, and a read-only Watch API.
- persistent file/Git/GitHub source configuration and fail-closed Workspace → Workflow → Task config resolution;
- GitHub HTTP ingress with workflow linkage, external-event wakeups, SSE resume cursors, and durable Attention notifications;
- permission requests mapped to precise Attention, approval-scoped resume, and atomic managed Result Contract publication;
- production RuntimeHost composition for observers, schedules, jobs, and notifications.

ZCode Desktop does not currently expose a documented non-interactive structured CLI protocol, so no fabricated adapter is shipped. See [docs/roadmap.md](docs/roadmap.md).

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
