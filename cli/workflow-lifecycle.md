# Workflow Lifecycle

## Install

```bash
agent-workflow install [target]
```

The installer:

1. detects conservative repository facts;
2. computes the managed file plan;
3. refuses to overwrite any pre-existing managed file;
4. records directories that did not exist before installation;
5. writes a project-local workflow snapshot, templates, schemas, and validator;
6. writes `docs/.agent-workflow-install.json` last;
7. creates no ACTIVE task.

Installation is development tooling only and must not change business logic.

## Create Task Contract

```bash
agent-workflow task create --mode <MODE> --objective <TEXT> --validate <CHECK> --accept <CRITERION> [options]
```

The generator:

1. requires an installed project workflow;
2. always targets `docs/agent-tasks/ACTIVE_TASK.json`;
3. refuses to replace an existing ACTIVE task or companion;
4. resolves source branch/commit from explicit flags or local Git facts;
5. requires explicit writable scope for `IMPLEMENT`;
6. always includes the Result Contract itself in `allowed_changes`;
7. machine-enforces `TEST_ONLY` / `REVIEW_ONLY` writable scope under `docs/agent-results/**`;
8. keeps every Result Contract under `docs/agent-results/**`;
9. validates the generated Task Contract before activation;
10. optionally writes non-authoritative `ACTIVE_TASK.md` with `--companion` and records its required cleanup in the completion contract.

## Validate

```bash
agent-workflow validate task <file>
agent-workflow validate result <file>
```

Validation uses the canonical packaged validator and returns its exit status.

Task permissions remain independent of the chosen executor. The validator also enforces result-path placement, read-only mode scope, Result Contract write permission, and completion-contract invariants.

Before execution and completion:

```bash
agent-workflow doctor --target . --json
agent-workflow status --target . --json
agent-workflow validate handoff --task docs/agent-tasks/ACTIVE_TASK.json --result <result-file> --target .
```

`doctor` is a read-only preflight. `status` derives the workflow state and the observed Result commit from repository facts. Joint handoff validation checks Task/Result identity, source revision, result path, and changed-file scope.

## Execute

Any compatible executor reads the same `ACTIVE_TASK.json`. It must obey the contract's mode, scope, source revision, validation requirements, acceptance criteria, result contract, and completion commit contract.

When complete, the executor writes the Result Contract/report and removes `ACTIVE_TASK.json`; it also removes `ACTIVE_TASK.md` when present and included in the completion contract. BLOCKED is a recoverable checkpoint, not completion: keep the ACTIVE task and run `agent-workflow task resume` when the blocker is resolved.

## Uninstall / release cleanup

```bash
agent-workflow uninstall [target]
```

Uninstall:

1. requires the installation ownership manifest;
2. refuses to run while an ACTIVE task or companion exists;
3. verifies the manifest identifies `Ran-sh/chatgpt_workflow`;
4. removes only `generated_files`;
5. removes only empty `generated_dirs` that were absent before installation;
6. removes the manifest last;
7. never infers ownership from filenames.

Pre-existing source code, product assets, tests, configuration, user data, CI, release logic, and unrelated documentation are outside automatic removal scope.
