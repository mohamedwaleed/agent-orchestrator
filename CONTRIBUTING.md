# Contributing to Agent Orchestrator

Thanks for your interest in contributing! This is an early-stage project — issues and pull requests are welcome.

## Getting started

```bash
git clone git@github.com:mohamedwaleed/agent-orchestrator.git
cd agent-orchestrator
pnpm install
pnpm build
pnpm test
```

**Prerequisites:** Node.js >= 20, pnpm >= 9, git, and `gh` (authenticated) for GitHub operations.

## Project layout

This is a pnpm workspace monorepo:

| Package | Purpose |
| --- | --- |
| `packages/types` | Shared types — adapter contract, ticket, task, plan, run state |
| `packages/core` | Orchestration engine + CLI entry point |
| `packages/tui` | Terminal dashboard (Ink) |
| `packages/adapter-codex` | Codex CLI adapter |
| `packages/adapter-devin` | Devin CLI adapter |

Read [`CONTEXT.md`](./CONTEXT.md) for the domain vocabulary and [`spec.md`](./spec.md) for the full design. Architectural decisions are recorded in [`docs/adr/`](./docs/adr).

## Development workflow

```bash
pnpm build          # build all packages
pnpm typecheck      # typecheck all packages (tsc --noEmit)
pnpm test           # run all tests (vitest)
pnpm -r dev         # watch mode for all packages
```

When working on a single package, you can scope commands with `pnpm --filter <name> <script>`, e.g. `pnpm --filter @orchestrator/core test`.

## Before opening a pull request

1. **Build, typecheck, and test pass locally:**
   ```bash
   pnpm build && pnpm typecheck && pnpm test
   ```
2. **Add tests** for new behavior. Tests use [vitest](https://vitest.dev) and live next to the source they cover (`*.test.ts`).
3. **Follow existing conventions** — TypeScript strict mode, ESM (`NodeNext`), no unused locals/parameters. Match the style of neighboring code.
4. **Keep PRs focused** — one logical change per PR. Reference the issue it closes (e.g. `Closes #12`).
5. **Don't commit secrets** or local config (`.env`, `.devin/config.local.json`, `.orchestrator/`).

## Commit messages

There is no strict format enforced yet. Write a concise message focused on *why* the change is needed. If your PR addresses an issue, reference it in the body.

## Adapters

Adapters are thin modules that bridge the orchestrator to a coding-agent CLI via subprocess. The contract is defined in `@orchestrator/types`:

1. `start_session(worktree_path, prompt) -> session_id`
2. `wait_for_completion(session_id) -> Result`
3. `attach(session_id) -> interactive_session`

Adapters do **not** handle commit or PR creation — that is the orchestrator's responsibility. If you want to add support for a new agent, model it on `packages/adapter-codex` or `packages/adapter-devin`.

## Reporting bugs

Open a [GitHub issue](https://github.com/mohamedwaleed/agent-orchestrator/issues) and include:

- What you expected to happen
- What actually happened (including error output)
- The command you ran
- Your environment (OS, Node version, adapter/agent CLI used)

## Code of conduct

By participating you agree to uphold the [Code of Conduct](./CODE_OF_CONDUCT.md).
