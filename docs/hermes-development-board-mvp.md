# Hermes Development Board MVP

This board is the local-first Kanban layer for using Pi as a Hermes Agent control surface. The MVP is scoped to development tasks and stores state under Pi's user-local agent data directory at `extension-state/hermes-board/<project-key>/board.json`.

## Columns

- `backlog`: ideas, audits, refactors, research dossiers, and monitor follow-ups.
- `ready`: scoped work with repo, goal, safety level, and verification command.
- `running`: work currently assigned to a local or Hermes run.
- `blocked`: work waiting on approval, credentials, remote access, failing checks, or human input.
- `review`: completed work with diffs, artifacts, notes, docs updates, or memory/skill proposals.
- `done`: accepted work with verification evidence.

## Card Types

- `coding-run`
- `repo-audit`
- `refactor`
- `docs-maintenance`
- `research-dossier`
- `infra-coordination`
- `workspace-transition`
- `monitor-alert`
- `memory-review`
- `skill-proposal`

## Local Pi Commands

- `/hermes-board`
- `/hermes-card-create <title>`
- `/hermes-card-move <id> <backlog|ready|running|blocked|review|done>`
- `/hermes-card-show <id>`
- `/hermes-card-review <id> [note]`

The `hermes_board` tool exposes the same local board model to the agent. It can create, list, move, block, review, annotate, and link cards to Hermes run/job IDs. It does not start Hermes jobs, write memory, install skills, mutate remotes, or contact bee01.

## Safety Rules

- The current implementation is local-only.
- Remote mutation, memory persistence, skill installation, shell execution, deployment, and overnight execution must remain separate approval-gated actions.
- Cards can record `remote-read`, `remote-mutation`, or `phi-sensitive` safety levels, but those labels are planning metadata until an approved executor is added.
- Review packets should record verification commands, artifacts, docs notes, proposed memory writes, and proposed skill changes before anything is persisted outside local board state.

## Next Implementation Slice

1. Add read-only Hermes run/job discovery and allow cards to show linked run status.
2. Add an approval-gated `start run from card` command for `ready` cards.
3. Add an overnight profile with duration, checkpoint interval, allowed paths, allowed commands, and stop conditions.
4. Extract the board/Hermes contract for reuse by a Codex plugin and later custom control center.
