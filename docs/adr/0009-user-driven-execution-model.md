# ADR-0009: User-Driven Execution Model

## Status

Proposed

## Context

The spec (spec.md) describes an execution model where waves run sequentially and automatically — Wave N+1 starts immediately after Wave N completes, with PRs auto-merged between waves. The user's only control point is the Merge Gate (enable/disable).

End-to-end testing revealed this model is problematic:

1. **No human review of PRs**: Auto-merging means PRs are merged without the user ever seeing them. This is unacceptable for production use — PRs need human review.
2. **No parallelism control**: All tasks in a wave run in parallel with no limit. A wave with 10 tasks spawns 10 concurrent agent sessions, which may overwhelm the system or hit rate limits.
3. **No visibility during execution**: The user sees "Executing..." and nothing else until the final summary. They don't know which tasks are running, which have completed, or what PRs were created.
4. **No way to attach mid-execution**: The spec says users can attach to any running session, but the auto-advance model doesn't pause between waves to give them a chance.
5. **Conflicts are opaque**: When a merge fails, the user sees "Conflicted" with no explanation of what happened or what to do.

## Decision

Replace the auto-execute model with a **user-driven state machine** where the user controls each step:

### New CLI Commands

| Command | Purpose |
|---------|---------|
| `plan --source ...` | Intake + planning. Saves run state. Shows waves and tasks. |
| `status [--last \| <run-id>]` | Shows current run state: tasks, waves, PRs, conflicts. |
| `execute-wave <wave> [--max-parallelism N] [--tasks id1,id2]` | Executes tasks in a wave. Does NOT merge or advance. |
| `merge-wave <wave>` | Merges completed PRs from a wave (after user reviews them on GitHub). |
| `continue` | Executes the next wave with pending tasks. |
| `run --source ...` | Full auto (tracer bullet mode — kept for backward compat). |

### Key Changes

1. **Max parallelism**: `execute-wave` accepts `--max-parallelism N` to limit concurrent sessions. Tasks are queued and run N at a time until the wave is done.

2. **Task selection**: `execute-wave` accepts `--tasks id1,id2` to run specific tasks from a wave. Remaining tasks stay pending for later.

3. **Separation of execute and merge**: `execute-wave` only runs the agent and creates PRs. `merge-wave` is a separate command the user runs after reviewing PRs on GitHub.

4. **State persistence**: Run state persists to `.orchestrator/state.json` (JSON MVP; SQLite per ADR-0002 is a future upgrade). This enables separate CLI invocations for each step.

5. **Progress logging**: The WaveExecutor emits progress events (wave start, task start, completion, failure with output, merge results) throughout execution.

6. **Conflict reporting**: Conflicted tasks capture the merge error in `conflictReason`. The status and completion summary show the PR URL, the error, and the action to take.

### Typical User Flow

```
1. orchestrator plan --source github owner/repo --adapter codex
   → Creates run, shows waves

2. orchestrator execute-wave 0 --last --max-parallelism 2
   → Runs 2 tasks at a time, creates PRs

3. (User reviews PRs on GitHub)

4. orchestrator merge-wave 0 --last
   → Merges approved PRs

5. orchestrator continue --last
   → Executes next wave

6. (repeat 2-5 until done)

7. orchestrator status --last
   → Shows full state at any time
```

### What Stays the Same

- Wave assignment is still deterministic via topological sort of dependencies
- Worktrees persist through the entire Run
- The `run` command still works as a full-auto convenience (tracer bullet)
- The TUI (ADR-0007) will consume the same `executeWave`/`mergeWave` methods
- The merge gate prompt is still injectable for testing

## Consequences

- **Positive**: User has full control over when waves execute, how many tasks run in parallel, and when PRs are merged. No PR is ever merged without explicit user action.
- **Positive**: State persists across CLI invocations — the user can plan, execute, and merge in separate terminal sessions.
- **Positive**: Progress logging gives real-time visibility into what's happening.
- **Positive**: Conflict reporting is actionable — the user knows what failed and what to do.
- **Negative**: More steps for the user — they can't just run one command and walk away. This is intentional — the `run` command is kept for cases where full-auto is acceptable.
- **Negative**: JSON file persistence is not as robust as SQLite (no concurrent access safety, no querying). This is an MVP — ADR-0002 still calls for SQLite, and the `RunStateManager` interface is designed so the backend can be swapped without touching callers.

## Relationship to Spec

This ADR deviates from spec.md's execution model (auto-advance, auto-merge) in favor of user control. The spec's Merge Gate is preserved but reframed: instead of a prompt between waves in a single `run`, the merge is a separate `merge-wave` command. The spec's Attach and Intervention features are unchanged — they work the same way regardless of whether execution is auto or user-driven.
