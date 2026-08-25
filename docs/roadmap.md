# Roadmap

## v2.0 — autonomous relay foundation

Implemented: vNext Task/Authorization/Decision contracts, capability gap, states, SQLite persistence, canonical events, trace/control lanes, redaction, durable control outbox, generation fencing, process/session restart reconciliation, FakeExecutor, fail-closed Codex adapter boundary, bounded state packets, automatic follow-up, runtime CLI, and v1.9 compatibility.

Long-running OS service packaging and production model credentials remain deployment choices outside the offline test suite.

## v2.1 — production auto-continue (implemented)

- audited production GPT decision provider;
- daemon service lifecycle, restart hooks, and notifications;
- filesystem/Git observer service entry point;
- approval/human reply commands;
- controlled live Codex smoke job.
- the built-in fail-closed isolated-copy boundary remains replaceable by a host-provided stronger boundary.

## v2.2 — multi-executor (implemented where a verifiable CLI protocol exists)

- Claude and Codex adapters behind the existing interface;
- deterministic priorities and readiness snapshots;
- adapter conformance and resume tests;
- canonical Attention mapping.

Adding an executor should not change the core state machine.

ZCode Desktop currently documents an interactive desktop Agent but not a supported non-interactive structured CLI protocol. GPT Relay therefore does not invent an unsafe adapter. The registry interface is the extension point when such a protocol becomes available.

## v2.3 — external events (implemented)

- GitHub CI/PR, filesystem, and signed webhook sources;
- durable external cursors and source-specific dedupe;
- Attention notification transports.

## v2.4 — advanced runtime (implemented)

Durable DAG barriers, generation-fenced remote runner jobs, idempotent schedules, and a bounded read-only Watch HTTP API are available. A graphical frontend remains optional and is intentionally not part of the headless npm package.

## v2.5 — production wiring and information-flow hardening (implemented)

- persistent file, Git, and GitHub source configuration with monotonic revisions and environment-only secret references;
- fail-closed Workspace → Workflow → Task configuration resolution;
- a production RuntimeHost that scans sources, emits schedule occurrences, runs durable jobs, and drains Attention notifications in order;
- signed source-scoped GitHub HTTP ingress, linked-workflow external-event wakeups, and retry-safe delivery handling;
- atomic managed Result Contract publication with idempotent content and conflict rejection;
- permission events converted to precise durable Attention and approval-scoped authorization on resume;
- workflow aggregate Watch queries plus cursor-resumable SSE on loopback by default;
- conservative semantic fallback recorded as classification evidence, never directly executed as a high-risk action.
