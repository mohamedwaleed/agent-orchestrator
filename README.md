# Agent Orchestrator

A local tool that takes tickets (GitHub issues or local Markdown files), assigns them to parallel waves, runs coding agents against each task in isolated git worktrees, and produces a PR per task.

It bridges the gap between ticket intake and agent execution: you declare dependencies upstream, the orchestrator topologically sorts tickets into waves, runs each task in its own worktree with a coding-agent CLI (Devin, Codex, ...), and opens one PR per task.

## Status

Early-stage / work in progress. The core orchestration engine, CLI, and Devin/Codex adapters exist. The Dashboard TUI and resume-from-interruption are not yet implemented. See [`spec.md`](./spec.md) for the full design and [`docs/adr/`](./docs/adr) for architectural decisions.

## How it works

1. **Intake** — fetch tickets from a ticket source (GitHub issues or local Markdown files).
2. **Planning** — read pre-declared dependencies, topologically sort tickets into waves, generate a task prompt per ticket.
3. **Approval / execution** — execute waves sequentially; within a wave, tasks run in parallel in isolated git worktrees. After each wave, completed PRs are merged into the base branch so the next wave sees prior work.
4. **PR per task** — the orchestrator squashes the agent's commits and opens one PR per task with a body referencing the original ticket.

See [`CONTEXT.md`](./CONTEXT.md) for the full domain vocabulary.

## Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9
- **git**
- **[gh](https://cli.github.com/)** CLI (authenticated) — used for all GitHub operations (reading issues, creating/merging PRs)
- A coding-agent CLI for the adapter you want to use: [Devin CLI](https://devin.ai) or [Codex CLI](https://github.com/openai/codex)

## Install

```bash
git clone git@github.com:mohamedwaleed/agent-orchestrator.git
cd agent-orchestrator
pnpm install
pnpm build
```

## Usage

```bash
# Full auto: plan + execute all waves + merge
orchestrator run --source github owner/repo --adapter codex

# User-driven flow (recommended):
orchestrator plan --source github owner/repo --adapter codex
orchestrator execute-wave 0 --last --max-parallelism 2
# (review PRs on GitHub)
orchestrator merge-wave 0 --last
orchestrator continue --last
# (repeat until done)
```

### Commands

| Command | Description |
| --- | --- |
| `plan --source <local\|github> <ref>` | Fetch tickets and create a wave plan. Saves run state. |
| `status [--last \| <run-id>]` | Show the current state of a run. |
| `execute-wave <wave> [--run <id> \| --last]` | Execute tasks in a specific wave. Does not merge. |
| `merge-wave <wave> [--run <id> \| --last]` | Merge completed PRs from a wave. |
| `continue [--run <id> \| --last]` | Execute the next wave that has pending tasks. |
| `run --source <local\|github> <ref>` | Full auto: plan + execute all waves + merge. |
| `resume <run-id>` | Resume an interrupted run. (not yet implemented) |

### Common options

| Option | Description |
| --- | --- |
| `--adapter <name>` | Adapter to use (`devin`, `codex`). Default: from config. |
| `--agent-model <model>` | Model for the agent CLI (e.g. `opus` for Devin, `o3` for Codex). |
| `--base-branch <name>` | Base branch for worktrees and PRs (default: `main`). |
| `--merge-gate` / `--no-merge-gate` | Require manual approval between waves / leave PRs open for review. |
| `--label <label>` | Filter GitHub issues by label. |
| `--no-pr` | Run execution but skip commit, push, PR, and merge. |
| `--max-parallelism N` | Limit concurrent sessions within a wave. |
| `--tasks id1,id2` | Run only specific tasks from a wave. |

### Local ticket files

Local tickets are Markdown files with YAML frontmatter:

```markdown
---
id: CODEX-TEST-1
title: Add a status endpoint
dependencies: []
---

Create a simple `GET /status` endpoint...
```

## Configuration

Layered config (each layer overrides the one below):

1. **Global** — `~/.config/orchestrator/config.yml`
2. **Repo** — `.orchestrator/config.yml`
3. **CLI flags**

```yaml
# .orchestrator/config.yml
adapter: devin
baseBranch: main
mergeGate: true
plannerProvider: openai
plannerModel: gpt-4o
ticketSource:
  kind: github
  ref: owner/repo
```

## Project layout

```
packages/
  types/          # shared types — adapter contract, ticket, task, plan, run state
  core/           # orchestration engine + CLI entry point
  tui/            # terminal dashboard (Ink) — in progress
  adapter-codex/  # Codex CLI adapter
  adapter-devin/  # Devin CLI adapter
```

## Development

```bash
pnpm install
pnpm build          # build all packages
pnpm typecheck      # typecheck all packages
pnpm test           # run all tests (vitest)
pnpm -r dev         # watch mode for all packages
```

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Issues and PRs welcome on [GitHub](https://github.com/mohamedwaleed/agent-orchestrator).

## License

[MIT](./LICENSE) © Mohamed Waleed
