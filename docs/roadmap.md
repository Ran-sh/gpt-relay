# Roadmap

## v2.0 — autonomous relay foundation

Implemented: vNext Task/Authorization/Decision contracts, capability gap, states, SQLite persistence, canonical events, trace/control lanes, redaction, dedupe, generation fencing, FakeExecutor, Codex adapter, bounded state packets, automatic follow-up, runtime CLI, and v1.9 compatibility.

Long-running OS service packaging and production model credentials remain deployment choices outside the offline test suite.

## v2.1 — production auto-continue

- audited production GPT decision provider;
- daemon service lifecycle, restart hooks, and notifications;
- filesystem/Git observer service entry point;
- approval/human reply commands;
- controlled live Codex smoke job.

## v2.2 — multi-executor

- ZCode and Claude adapters behind the existing interface;
- deterministic priorities and readiness snapshots;
- adapter conformance and resume tests;
- canonical Attention mapping.

Adding an executor should not change the core state machine.

## v2.3 — external events

- GitHub CI/PR, filesystem, and signed webhook sources;
- durable external cursors and source-specific dedupe;
- Attention notification transports.

## v2.4+

Parallel barriers, remote runners, schedules, and an optional watch GUI only after operational history and fault-injection coverage exist.
