# AGENTS.md

Guidance for AI agents (and humans) working in this repo.

## What this is

Agent Orchestrator — a local tool that takes tickets, assigns them to parallel waves, runs coding agents in isolated git worktrees, and produces a PR per task. pnpm + TypeScript monorepo.

- Domain vocabulary: `CONTEXT.md`
- Full design spec: `spec.md`
- Architectural decisions: `docs/adr/`

## Project layout

| Package | Purpose |
| --- | --- |
| `packages/types` | Shared types — adapter contract, ticket, task, plan, run state |
| `packages/core` | Orchestration engine + CLI entry point (`orchestrator`) |
| `packages/tui` | Terminal dashboard (Ink) |
| `packages/adapter-codex` | Codex CLI adapter |
| `packages/adapter-devin` | Devin CLI adapter |

## Commands

```bash
pnpm install              # install deps (workspace)
pnpm build                # build all packages (tsc)
pnpm typecheck            # typecheck all packages (tsc --noEmit)
pnpm test                 # run all tests (vitest)
pnpm -r dev               # watch mode for all packages
```

Scope to one package: `pnpm --filter @orchestrator/core test`.

## Conventions

- **TypeScript strict mode**, ESM with `NodeNext` module resolution.
- `noUnusedLocals` and `noUnusedParameters` are on — do not leave unused declarations (the build will fail).
- Tests use **vitest**, colocated with source as `*.test.ts`.
- Do not add comments unless asked; preserve existing comments when editing.
- Match the style of neighboring code. Look at imports and surrounding context before writing.
- Adapters are thin subprocess wrappers. They do NOT handle commit/PR creation — that lives in core. Model new adapters on `packages/adapter-codex` or `packages/adapter-devin`.

## Before submitting changes

```bash
pnpm build && pnpm typecheck && pnpm test
```

All three must pass. CI runs the same.

## Do not commit

- `.env`, `.env.local`
- `.devin/config.local.json` (local agent permissions)
- `.orchestrator/` (runtime state — worktrees, run state)
