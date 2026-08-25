# Reference project assessment

The attached document referred to `milind-soni/OpenMausBoth`, which is not a public GitHub repository. The public project is [`milind-soni/OpenMausBot`](https://github.com/milind-soni/OpenMausBot), reviewed at commit `ba3ad4bfade15f9c6eca884002b06b9d8e3adce4` on 2026-08-25. It is Apache-2.0.

Useful patterns adopted conceptually:

- a registry that degrades unknown or unavailable drivers instead of crashing the fleet;
- one normalized fan-in event stream across provider-native protocols;
- harness-owned child processes, sessions, cancellation, and permission events;
- fixture CLIs / fake drivers for protocol tests without model calls;
- persistent cursors, explicit session identity, and generation fencing;
- separate raw evidence from compact model-facing context;
- large-output spill, bounded context, fail-closed approvals, and liveness reconciliation.

Not imported: Electron/React UI, bot personalities, marketplace/cloud-computer UI, platform packaging, or OpenMausBot source files. GPT Relay is a headless control plane.

`Ran-sh/chatgpt_workflow` v1.9 supplies the imported repository contract, install manifest, validators, scope checks, and resumable BLOCKED history. Its prior `dsh-vision` / `dsh-crew` findings motivate immutable attempts, preflight capability matching, bounded scopes, and separate runtime persistence.
