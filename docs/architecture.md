# GPT Relay architecture

The primary GPT owns the objective, capability analysis, repository-side work, evidence review, and final acceptance. The relay owns observation, normalization, persistence, deduplication, classification, and routing. The daemon owns durable state, attempts, sessions, process reconciliation, and loop budgets. Executors own only the delegated capability gap.

`WorkflowDaemon` computes the capability gap, selects an executor through `ExecutorRegistry`, creates immutable attempts, collects normalized events, validates results, builds a bounded packet, and executes a typed decision.

`RelayPipeline` normalizes provider events and writes them to `SQLiteRuntimeStore` before any router runs. Trace events stop there. Control events use a durable routed marker: failed delivery remains pending, and `drainPending` replays the outbox after restart.

`SQLiteRuntimeStore` is the runtime truth for workflow runs, attempts, sessions, events, cursors, Attention, and artifact metadata. Git remains the durable, portable ledger for Task / Result Contracts and auditable evidence.

`CodexAdapter` uses the non-interactive JSONL protocol. It treats a structured terminal event plus process exit as evidence; neither one is sufficient alone. Resume checks that the returned Codex thread ID equals the requested session. Credential-denied jobs receive a minimal environment and isolated home. Writable jobs default to `IsolatedCopyWorkspaceBoundary`: Git/runtime metadata and source symlinks are excluded, execution occurs in a temporary copy, and only successful regular-file changes matching allowed but not forbidden scopes are applied back. Deletions additionally require destructive authorization. A host can replace the boundary; explicitly disabling it refuses launch.

Supported workflow states are `RUNNING`, `WAITING_FOR_EXECUTOR`, `WAITING_FOR_CAPABILITY`, `WAITING_FOR_APPROVAL`, `WAITING_FOR_HUMAN`, `VERIFYING`, `PAUSED`, `COMPLETED`, `FAILED`, and `CANCELLED`.

Every execution creates an immutable attempt. A same-task follow-up can reuse the provider session, but it receives a new attempt and a new monotonic session generation. Cross-task session reuse is forbidden.

Executor PIDs are stored with RUNNING sessions. A fresh `ProcessSupervisor` hydrates those records, probes liveness, and marks missing processes LOST. The daemon registers and unregisters handles and closes attempt/workflow state with Attention when any executor lifecycle phase throws.

Core code depends on readiness, capabilities, start, optional resume, events, cancel, and result collection. Provider CLI flags and native messages stay in the adapter. A new executor should be registered without changing the state machine or scheduler.

Each workflow has attempt and action budgets. Repeated failure ends in Attention rather than an unbounded retry loop. Unknown decisions, events, and authorization actions fail closed.
