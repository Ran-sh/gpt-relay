# Agent information flow

The main optimization is to reduce what crosses each boundary while preserving evidence and auditability.

Before dispatch, the adapter receives a rendered Delegated Scope Contract, not the full parent conversation. The prompt includes the minimal objective, capabilities, allowed and forbidden changes, validation, evidence return fields, authorization flags, and an optional bounded handoff.

During execution, provider-native messages become canonical events. Tool output and streaming progress use the trace lane. Terminal, approval, result, human, and capability-change events use the control lane.

The relay persists each event before routing. A provider cursor or native ID builds its idempotency key. Retries and reconnects do not repeat actions. Session generations fence late events from superseded processes.

Large payloads are redacted, stored once as artifacts, and replaced with a preview plus an `artifact://` reference. The primary GPT requests them only when relevant.

After completion, the bounded packet contains the objective, state, Task/scope, attempt, non-sensitive session metadata, latest Result/acceptance, Attention, recent control events, artifact references, and a compact handoff. It applies byte/event budgets, removes trace events, truncates prose, and redacts credentials.

`FOLLOW_UP` preserves the task binding and exact provider session when supported, but creates a new attempt and generation. `RETRY` creates a fresh execution context. `COMPLETE` is rejected unless the latest result is validated PASS and acceptance is satisfied.
