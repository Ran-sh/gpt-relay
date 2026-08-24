# Capability-Based Delegation

## Principle

Delegate by missing capability, not by agent name. Codex may inspect repositories, edit code, run shell commands and tests, use browsers, review changes, and operate Git or GitHub when those capabilities are available and authorized.

## Decision

1. Identify the work and its required capabilities: repository read/write, shell, browser, device, credential confirmation, publication, or another real environment.
2. Run `agent-workflow doctor --json` when an installed project has an ACTIVE task.
3. If the current agent has the required capabilities, it completes the work directly within the authorized scope.
4. Create or retain an ACTIVE task only for capabilities that are actually missing or must happen in a different environment.
5. Capabilities decide where work can run. They never grant permission beyond the Task Contract.

## Recovery

A `BLOCKED` result is a checkpoint, not completion. Keep the ACTIVE task and the immutable blocked Result Contract. After the missing capability becomes available, run `agent-workflow task resume`; this opens a new attempt and a new result path without overwriting the old evidence.

## Completion

Before removing an ACTIVE task, stamp the Result Contract and run `agent-workflow validate handoff`. The joint validator checks task identity, result path, source revision, and changed-file scope. Contract validation means the evidence envelope is valid; it does not mean the business outcome is PASS.
