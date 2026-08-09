# Agent Orchestrator

A local CLI tool that takes **tickets** (GitHub issues or local Markdown files with pre-declared dependencies), assigns them to **parallel waves**, runs coding agents against each task in **isolated git worktrees**, and produces **one PR per task**.

It bridges the gap between ticket intake and agent execution: you declare dependencies upstream (via the grilling workflow), the orchestrator topologically sorts tickets into waves, runs each task in its own worktree with a coding-agent CLI (Devin, Codex, ...), squashes the agent's commits, and opens a PR per task — merging completed PRs between waves so later waves see prior work.

```
            ┌─────────┐   dependencies   ┌──────────┐   topological sort   ┌───────┐
tickets ──▶ │ Intake  │ ───────────────▶ │ Planner  │ ───────────────────▶ │ Waves │
            └─────────┘                  └──────────┘                      └───────┘
                                                                              │
              ┌───────────────────────────────────────────────────────────────┘
              ▼
   Wave 0:  [Task A]  [Task B]  [Task C]   ← run in parallel in isolated worktrees
              │         │         │
              ▼         ▼         ▼
            PR A      PR B      PR C        ← one PR per task, merged into base branch
              │
              ▼
   Wave 1:  [Task D]  [Task E]             ← branched from updated base branch
              │         │
              ▼         ▼
            PR D      PR E
```

## Status

Early-stage / work in progress. What works today:

- Core orchestration engine (intake, planning, wave execution, commit + PR creation)
- CLI (`orchestrator plan / run / execute-wave / merge-wave / continue / status`)
- Devin and Codex adapters (CLI subprocess interface)
- Layered YAML configuration
- Local and GitHub ticket sources
- Vitest test suite (49 tests passing)

Not yet implemented:

- Dashboard TUI (Ink) — Approval Gate and live session monitoring
- `resume` for interrupted runs
- SQLite state persistence (currently JSON state file)
- Attach to running sessions
- Merge conflict detection / intervention phase
- Adapter auto-discovery via `node_modules` scan

See [`spec.md`](./spec.md) for the full design and [`docs/adr/`](./docs/adr) for architectural decisions.

## Why

After the grilling workflow produces tickets with pre-declared dependencies, there's no automated way to execute them in parallel using coding agents. Developers must manually create branches, start agent sessions one at a time, wait for each to finish, review, commit, create PRs, merge — then repeat for dependent tasks. This is tedious, serial, and wastes the parallelism that the tickets' dependency graph enables.

Agent Orchestrator automates that pipeline: from "I have a set of dependency-annotated tickets" to "I have PRs for all of them."

## How it works

A **Run** is a single execution of the orchestrator, with these phases:

1. **Intake** — fetch tickets from a ticket source (GitHub issues or local Markdown files). Tickets carry pre-declared dependencies (from the upstream grilling workflow) and optional metadata.
2. **Planning** — read pre-declared dependencies, topologically sort tickets into **Waves** (deterministic, no LLM), generate a **Task Prompt** per ticket (LLM, using codebase context), and assess ticket size (non-blocking warnings).
3. **Approval Gate** *(planned)* — review the Plan (dependency graph, waves, prompts, size warnings, adapter assignments) in the TUI before any task runs.
4. **Execution** — per wave (sequential): create worktrees from the base branch → start agent sessions in parallel (automatic accept mode) → wait for completion → squash commits + create one PR per task → merge PRs into the base branch → flag merge conflicts.
5. **Completion** — report summary: completed PRs, failed tasks, conflicted tasks.
6. **Intervention** *(planned)* — asynchronously attach to failed/conflicted sessions, resolve, retry.

**Key properties:**

- **1:1 ticket → task mapping.** Each ticket becomes exactly one task. No splitting or merging — sizing is the upstream grilling workflow's job.
- **Wave-based parallelism.** Waves run sequentially; within a wave, tasks run in parallel. Wave N+1 starts only after Wave N completes.
- **Worktree isolation.** One git worktree per task, branched from the base branch. Parallel tasks never interfere. Between waves, completed PRs are merged so the next wave's worktrees include prior work.
- **Orchestrator owns git output.** Adapters only manage the agent session lifecycle. Commit (squash), PR creation, and merging are the orchestrator's responsibility — uniform output regardless of which agent did the work.
- **Agents run unattended.** Adapters pass flags that disable all approval prompts. Agents never block waiting for user interaction.

See [`CONTEXT.md`](./CONTEXT.md) for the full domain vocabulary.

## Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9
- **git**
- **[gh](https://cli.github.com/)** CLI, authenticated — used for all GitHub operations (reading issues, creating/merging PRs). No direct GitHub API dependency.
- A coding-agent CLI for the adapter you want to use:
  - **[Devin CLI](https://devin.ai)** — for the `devin` adapter
  - **[Codex CLI](https://github.com/openai/codex)** — for the `codex` adapter

## Install

```bash
git clone git@github.com:mohamedwaleed/agent-orchestrator.git
cd agent-orchestrator
pnpm install
pnpm build
```

The `orchestrator` CLI is available at `packages/core/dist/cli.js`. You can symlink it or run it via `node`:

```bash
node packages/core/dist/cli.js plan --source github owner/repo --adapter codex
```

## Usage

### Full-auto (tracer bullet mode)

Plan + execute all waves + merge in one command:

```bash
orchestrator run --source github owner/repo --adapter codex
```

### User-driven flow (recommended)

Gives you a checkpoint between each wave to review PRs on GitHub before merging:

```bash
# 1. Fetch tickets and create a wave plan (saves run state)
orchestrator plan --source github owner/repo --adapter codex

# 2. Execute wave 0 (tasks run in parallel in isolated worktrees)
orchestrator execute-wave 0 --last --max-parallelism 2

# 3. Review the PRs on GitHub

# 4. Merge completed PRs from wave 0 into the base branch
orchestrator merge-wave 0 --last

# 5. Execute the next pending wave
orchestrator continue --last

# (repeat 2–5 until done)
```

### Local tickets

Orchestrate from a folder of Markdown files instead of GitHub:

```bash
orchestrator plan --source local ./tickets --adapter devin
```

### Dry run (no PRs)

Test execution — worktree creation and agent sessions run, but commit/push/PR/merge are skipped:

```bash
orchestrator execute-wave 0 --last --no-pr
```

### Commands

| Command | Description |
| --- | --- |
| `plan --source <local\|github> <ref>` | Fetch tickets and create a wave plan. Saves run state for later commands. |
| `status [--last \| <run-id>]` | Show the current state of a run (tasks, waves, PRs, conflicts). |
| `execute-wave <wave> [--run <id> \| --last]` | Execute tasks in a specific wave. Does **not** merge or advance. |
| `merge-wave <wave> [--run <id> \| --last]` | Merge completed PRs from a wave into the base branch. |
| `continue [--run <id> \| --last]` | Execute the next wave that has pending tasks. |
| `run --source <local\|github> <ref>` | Full auto: plan + execute all waves + merge. |
| `resume <run-id>` | Resume an interrupted run. *(not yet implemented)* |

### Options

| Option | Applies to | Description |
| --- | --- | --- |
| `--source <local\|github> <ref>` | `plan`, `run` | Ticket source. `local <dir>` or `github <owner/repo>`. |
| `--adapter <name>` | all | Adapter to use: `devin` or `codex`. Default: from config. |
| `--agent-model <model>` | all | Model for the agent CLI (e.g. `opus` for Devin, `o3` for Codex). |
| `--base-branch <name>` | all | Base branch for worktrees and PRs (default: `main`). |
| `--merge-gate` / `--no-merge-gate` | all | Require manual approval between waves / leave PRs open for review. Default: enabled. |
| `--label <label>` | `plan`, `run` | Filter GitHub issues by label. |
| `--no-pr` | `execute-wave`, `continue` | Run execution but skip commit, push, PR, and merge. |
| `--max-parallelism N` | `execute-wave`, `continue` | Limit concurrent sessions within a wave. |
| `--tasks id1,id2` | `execute-wave` | Run only specific tasks from the wave. |
| `--planner-provider <name>` | `plan`, `run` | Planner LLM provider (e.g. `openai`). |
| `--planner-model <name>` | `plan`, `run` | Planner LLM model (e.g. `gpt-4o`). |
| `--prompt-template <path>` | `plan`, `run` | Path to a custom prompt template. |
| `--run <id>` / `--last` | most | Target a specific run by ID, or the most recent run. |

## Ticket sources

### GitHub issues

```bash
orchestrator plan --source github owner/repo --adapter codex
orchestrator plan --source github owner/repo --label bug --adapter devin
```

Tickets are fetched via the `gh` CLI. Dependencies are parsed from a structured convention in the issue body, written by the upstream grilling workflow:

```html
<!-- deps: #12, #15 -->
```

### Local files

```bash
orchestrator plan --source local ./tickets --adapter devin
```

Local tickets are Markdown files with YAML frontmatter:

```markdown
---
id: CODEX-TEST-1
title: Add a status endpoint
labels: [backend, api]
dependencies: []
prompt: |
  Add a GET /status endpoint returning {"status":"ok","version":"1.0.0"}.
  Include a test.
---

Create a simple `GET /status` endpoint in the project that returns the JSON
response `{"status": "ok", "version": "1.0.0"}`. Add a basic test that verifies
the endpoint returns the expected response.
```

**Frontmatter fields:**

| Field | Required | Description |
| --- | --- | --- |
| `id` | yes | Unique identifier for the ticket. |
| `title` | yes | Human-readable title. |
| `dependencies` | yes | List of ticket IDs this ticket depends on. Empty array if none. |
| `labels` | no | Labels carried through to the task. |
| `prompt` | no | Pre-written task prompt. If present, the Planner skips LLM generation and uses this directly. |

Both sources normalize to a common Ticket shape before Planning — the Planner and execution engine don't care where tickets came from.

## Configuration

Layered config — each layer overrides the one below (deep-merged, so nested objects like `ticketSource` combine field-by-field):

1. **Global** — `~/.config/orchestrator/config.yml` (user-wide defaults)
2. **Repo** — `.orchestrator/config.yml` (team-shared, checked into the repo)
3. **CLI flags** (one-off overrides)

```yaml
# .orchestrator/config.yml
adapter: devin              # default adapter: devin | codex
baseBranch: main            # branch worktrees are created from and PRs target
mergeGate: true             # require approval between waves
plannerProvider: openai     # LLM provider for prompt generation
plannerModel: gpt-4o        # LLM model for prompt generation
ticketSource:
  kind: github              # github | local
  ref: owner/repo           # owner/repo for github, directory for local
  filter: bug               # optional label filter (github only)
```

## Adapters

Adapters are pluggable modules that bridge the orchestrator to a specific coding agent. The contract is limited to **session lifecycle** — adapters do NOT handle commit or PR creation (that's the orchestrator's job, ensuring uniform output across all agents).

**Contract:**

```typescript
interface Adapter {
  name: string;
  startSession(worktreePath: string, prompt: string): Promise<string>;      // -> session_id
  waitForCompletion(sessionId: string): Promise<AdapterResult>;
  attach(sessionId: string): Promise<InteractiveSession>;
}

interface AdapterResult {
  success: boolean;     // orchestrator decides commit+PR vs. failed
  exitCode: number;
  output: string;       // full stdout+stderr, for diagnostics on failure
  lastMessage: string;  // agent's own summary — used as the PR body
}
```

Adapters interface with agents via **CLI subprocess** — spawning the agent's CLI as a child process. Completion is detected via process exit code. No API/SDK dependency, so any agent with a CLI can be supported.

**Built-in adapters:**

| Adapter | Package | CLI invocation |
| --- | --- | --- |
| Devin | `@orchestrator/adapter-devin` | `devin -p --prompt-file <file> --permission-mode bypass` (cwd = worktree) |
| Codex | `@orchestrator/adapter-codex` | `codex exec <prompt> -C <worktree> --json --dangerously-bypass-approvals-and-sandbox -o <last-msg>` |

Both run agents in **automatic accept mode** — flags disable all approval prompts so agents never block waiting for user interaction.

**Writing a new adapter:** model it on `packages/adapter-codex` or `packages/adapter-devin`. Implement the `Adapter` interface from `@orchestrator/types`, spawn the agent CLI, detect completion via exit code, parse output for `lastMessage`.

## Task lifecycle

Each task moves through these statuses:

| Status | Meaning |
| --- | --- |
| `pending` | Not yet started. |
| `running` | Agent session is active in the worktree. |
| `completed` | Agent finished successfully; PR created. |
| `failed` | Agent finished without success or errored. Held for intervention — does not block other tasks in the wave. |
| `blocked` | Dependencies not yet satisfied (or a dependency failed). Held until dependencies resolve. |
| `conflicted` | PR merge into the base branch conflicted with another task's changes. Held for intervention. |

Failed and conflicted tasks are held for user intervention and do not block other tasks in the same wave. Blocked tasks auto-unblock when their failed dependency is fixed and completes.

## PRs and commits

- **One PR per task.** Branch naming: `orchestrator/<task-id>-<slug>` — distinguishes orchestrator-generated PRs from manual ones.
- **Squash commit.** All commits the agent made during the session are squashed into one clean commit. Message derived from the ticket title and task prompt.
- **PR body** includes: the original ticket reference, the task prompt, the agent's `lastMessage` (its own summary of what it did), any user modification messages logged during Attach *(planned)*, and a session reference.
- **All GitHub operations** (reading issues, creating PRs, merging PRs) go through the `gh` CLI — the orchestrator shells out to `gh`, which handles authentication and API calls. `gh` is a prerequisite.

## Project layout

```
packages/
  types/          # shared types — adapter contract, ticket, task, plan, run state
  core/           # orchestration engine + CLI entry point (orchestrator)
  tui/            # terminal dashboard (Ink) — in progress
  adapter-codex/  # Codex CLI adapter
  adapter-devin/  # Devin CLI adapter
docs/adr/         # architectural decision records (0001–0009)
tickets/          # example local ticket files
CONTEXT.md        # domain vocabulary (ubiquitous language)
spec.md           # full design spec
```

## Development

```bash
pnpm install
pnpm build          # build all packages (tsc)
pnpm typecheck      # typecheck all packages (tsc --noEmit)
pnpm test           # run all tests (vitest)
pnpm -r dev         # watch mode for all packages
```

Scope to one package: `pnpm --filter @orchestrator/core test`.

TypeScript strict mode, ESM with `NodeNext` module resolution. Tests use [vitest](https://vitest.dev) and are colocated with source as `*.test.ts`.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Issues and PRs welcome on [GitHub](https://github.com/mohamedwaleed/agent-orchestrator).

## License

[MIT](./LICENSE) © Mohamed Waleed
