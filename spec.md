## Problem Statement

After the grilling workflow produces Tickets (GitHub issues or local files with pre-declared dependencies), there is no automated way to execute those Tickets in parallel using coding agents. Developers must manually create branches, start agent sessions one at a time, wait for each to finish, review the output, commit, create PRs, and merge — then repeat for dependent tasks. This is tedious, serial, and wastes the parallelism that the Tickets' dependency graph enables. The gap between "I have a set of dependency-annotated Tickets" and "I have PRs for all of them" is entirely manual.

## Solution

A local CLI tool — the Agent Orchestrator — that takes Tickets from a Ticket Source (GitHub issues or local Markdown files), Plans them into parallel Waves via deterministic topological sort of their pre-declared dependencies, generates context-aware Task Prompts using an LLM, and after user approval at the Approval Gate, executes each Wave by running coding agents in isolated git worktrees in parallel. Each completed Task gets a squashed commit and a PR. The orchestrator merges PRs between Waves so later Waves see prior work. A TUI Dashboard lets the user monitor all Sessions in real time and Attach to any running Session to command modifications. Failed Tasks fail independently without blocking their Wave; blocked Tasks auto-unblock when their dependencies are resolved. State is persisted in SQLite so interrupted Runs can be resumed explicitly.

## User Stories

1. As a developer, I want to fetch Tickets from GitHub issues, so that I can orchestrate work tracked in my repo's issue tracker
2. As a developer, I want to fetch Tickets from local Markdown files with YAML frontmatter, so that I can orchestrate work that isn't in GitHub
3. As a developer, I want to specify a GitHub repo and optional label filter, so that I only orchestrate the issues I care about
4. As a developer, I want to specify a local directory for Ticket files, so that I can orchestrate from a folder of task descriptions
5. As a developer, I want the orchestrator to present fetched Tickets for selection, so that I can choose which ones to include in a Run
6. As a developer, I want the orchestrator to read pre-declared dependencies from Tickets, so that it knows which Tasks depend on which
7. As a developer, I want the orchestrator to parse `<!-- deps: #12, #15 -->` blocks from GitHub issue bodies, so that dependencies declared by the grilling workflow are respected
8. As a developer, I want the orchestrator to parse `dependencies` fields from local file frontmatter, so that dependencies declared in local Tickets are respected
9. As a developer, I want the orchestrator to topologically sort Tickets into Waves, so that independent Tasks run in parallel and dependent Tasks run after their dependencies
10. As a developer, I want the orchestrator to detect circular dependencies and error clearly, so that I can fix the Ticket declarations
11. As a developer, I want the Planner to generate context-aware Task Prompts using an LLM, so that each agent receives a prompt that references relevant files and patterns in my codebase
12. As a developer, I want the Planner to use a `prompt` field from Ticket frontmatter if present, so that I can bypass LLM generation and provide my own prompt
13. As a developer, I want the Planner to assess Ticket size and emit non-blocking warnings for oversized Tickets, so that I can decide at the Approval Gate whether to proceed or split the Ticket upstream
14. As a developer, I want to review the Plan (Dependency Graph, Waves, Task Prompts, size warnings, adapter assignments) in a TUI Dashboard, so that I can verify the plan before execution
15. As a developer, I want to edit a Task Prompt in my `$EDITOR` from the Approval Gate, so that I can refine the prompt with full editing power
16. As a developer, I want to change adapter assignments per Task at the Approval Gate, so that I can use different agents for different Tasks
17. As a developer, I want to explicitly approve the Plan before any Task runs, so that I retain control over what gets executed
18. As a developer, I want to cancel the Run at the Approval Gate, so that I can abort without side effects
19. As a developer, I want the orchestrator to create a git worktree per Task branched from the Base Branch, so that parallel Tasks have filesystem-level isolation
20. As a developer, I want worktrees for Wave N+1 to be branched from the Base Branch after Wave N's PRs are merged, so that later Tasks see earlier Tasks' code
21. As a developer, I want the orchestrator to start agent Sessions in parallel within a Wave, so that all independent Tasks run simultaneously
22. As a developer, I want agents to run in automatic accept mode, so that they never block waiting for approval prompts
23. As a developer, I want the orchestrator to wait for all Sessions in a Wave to complete before moving to the next Wave, so that dependencies are respected
24. As a developer, I want the orchestrator to squash all agent commits into one clean commit per Task, so that PR history is uniform and reviewable
25. As a developer, I want the orchestrator to create one PR per Task with a structured body (Ticket reference, Task Prompt, agent's lastMessage, attach audit trail), so that reviewers have full context
26. As a developer, I want the orchestrator to auto-merge completed PRs into the Base Branch between Waves, so that the next Wave's worktrees include prior work
27. As a developer, I want to enable a Merge Gate between Waves, so that I can review PRs before they're merged for high-stakes task graphs
28. As a developer, I want the orchestrator to detect merge conflicts when merging PRs sequentially, so that conflicting PRs are flagged rather than silently broken
29. As a developer, I want conflicting PRs to be flagged as `conflicted` and held for my intervention, so that I can resolve them manually or via Attach
30. As a developer, I want non-conflicting PRs in a Wave to proceed normally even when another PR conflicts, so that one conflict doesn't block the entire Wave
31. As a developer, I want a Task that fails to be marked as `failed` without blocking other Tasks in the same Wave, so that parallelism is preserved
32. As a developer, I want Tasks in later Waves whose dependencies failed to be marked as `blocked`, so that they don't run until their dependencies are resolved
33. As a developer, I want blocked Tasks to automatically unblock when their failed dependency is fixed and completes, so that the Run continues without manual intervention
34. As a developer, I want to manually unblock a Task, so that I can proceed even if I decide the dependency failure is unrelated to the Task's scope
35. As a developer, I want to Attach to any running Session at any time from the Dashboard, so that I can observe the agent working in real time
36. As a developer, I want to send messages to the agent while Attached, so that I can command modifications to the code
37. As a developer, I want the orchestrator to be aware when I'm Attached and not auto-timeout the Session, so that my interaction isn't interrupted
38. As a developer, I want messages I send during Attach to be logged as an audit trail, so that reviewers can see what modifications I requested
39. As a developer, I want the attach audit trail included in the PR body, so that code reviewers have full context on user-requested changes
40. As a developer, I want the orchestrator to ask me on detach whether the issue was resolved, so that it can correctly update the Task Status
41. As a developer, I want a TUI Dashboard showing all Sessions, their Task Statuses, streaming logs, and the current Wave, so that I can monitor parallel execution at a glance
42. As a developer, I want to select a Session from the Dashboard to Attach to it, so that I can intervene without leaving the terminal
43. As a developer, I want Run State persisted in SQLite, so that an interrupted Run can be resumed
44. As a developer, I want to explicitly resume an interrupted Run via `orchestrator resume <run-id>`, so that I control when to resume
45. As a developer, I want to resume the most recent Run via `orchestrator resume --last`, so that I don't need to remember the run ID
46. As a developer, I want the orchestrator to reconnect to running Sessions on resume using stored session IDs, so that in-progress work isn't lost
47. As a developer, I want worktrees to persist through the entire Run, so that I can inspect them during execution and in the Intervention phase
48. As a developer, I want worktrees cleaned up only after the Run is complete, so that disk space is reclaimed but not prematurely
49. As a developer, I want a Completion summary showing completed PRs, failed Tasks, and conflicted Tasks, so that I know what needs attention
50. As a developer, I want to enter an Intervention phase after Completion, so that I can Attach to failed/conflicted Sessions and resolve them asynchronously
51. As a developer, I want layered Config (global, repo-level, CLI flags), so that team-shared settings and personal preferences don't conflict
52. As a developer, I want to configure the default adapter in Config, so that all Tasks use my preferred agent unless overridden
53. As a developer, I want to configure the Base Branch in Config, so that worktrees and PRs target the right branch
54. As a developer, I want to configure the Planner LLM provider and model in Config, so that I can use my preferred LLM for prompt generation
55. As a developer, I want to configure the Merge Gate toggle in Config, so that I can enable or disable the safety checkpoint per project
56. As a developer, I want to customize the Prompt Template, so that project-specific conventions and agent-specific directives are injected into Task Prompts
57. As a developer, I want the orchestrator to use the `gh` CLI for all GitHub operations, so that I don't need to manage separate API tokens
58. As a developer, I want Adapters distributed as NPM packages with auto-discovery, so that I can install new agent support with a single command
59. As a developer, I want to use the Devin adapter, so that I can orchestrate Devin CLI agents
60. As a developer, I want to use the Codex adapter, so that I can orchestrate Codex CLI agents
61. As a developer, I want the Devin adapter to pass `--permission-mode auto-accept` and `--prompt-file`, so that Devin runs without blocking on approvals
62. As a developer, I want the Codex adapter to pass `--dangerously-bypass-approvals-and-sandbox` and `--json`, so that Codex runs without blocking and produces parseable output
63. As a developer, I want the Codex adapter to use the `-o` flag for last-message output, so that the agent's summary is reliably captured for the PR body
64. As a developer, I want the orchestrator to detect completion via process exit code, so that it knows when each agent Session is done
65. As a developer, I want the Adapter Result to include the agent's `lastMessage`, so that the PR body contains the agent's own summary of what it did
66. As a developer, I want the Adapter Result to include full `output`, so that I can diagnose failures without needing to Attach
67. As a developer, I want branch naming to follow `orchestrator/<task-id>-<slug>`, so that orchestrator-generated PRs are distinguishable from manual ones
68. As a developer, I want to build and extend Adapters without touching the core orchestrator, so that I can support new agents independently
69. As a developer, I want the Adapter contract to be limited to session lifecycle (start, wait, attach), so that adapter authors have a minimal surface to implement
70. As a developer, I want the orchestrator to own commit and PR creation, so that output is uniform regardless of which agent did the work
71. As a developer, I want the project structured as a pnpm monorepo with workspaces, so that the core, TUI, and adapters are independently developed and published
72. As a developer, I want the TUI built with Ink (React for CLIs), so that the Dashboard is a stateful, real-time terminal UI
73. As a developer, I want the Planner LLM to use a pluggable provider abstraction (Vercel AI SDK), so that I can use OpenAI, Anthropic, Ollama, or other providers
74. As a developer, I want the Planner LLM to use structured output / function calling, so that the Plan is machine-readable, not free-text
75. As a developer, I want Tickets normalized to a common shape regardless of source, so that the Planner and execution engine don't care where Tickets came from

## Implementation Decisions

### Architecture

- **Monorepo with pnpm workspaces** (ADR-0005, ADR-0006). Packages: `@orchestrator/types` (shared contracts), `@orchestrator/core` (orchestration engine), `@orchestrator/tui` (Ink dashboard), `@orchestrator/adapter-devin`, `@orchestrator/adapter-codex`. External adapter authors publish standalone `@orchestrator/adapter-<name>` packages.

- **TypeScript / Node.js** (ADR-0001). ES modules (`"type": "module"`), NodeNext module resolution, Node 20+.

- **Ink (React for CLIs) for the TUI** (ADR-0007). The Dashboard and Approval Gate are React components rendered in the terminal. Uses `useInput` for keyboard navigation, `$EDITOR` for content edits.

### Adapter Contract

The Adapter interface is the seam between the orchestrator and coding agents. Three operations:

```typescript
interface Adapter {
  name: string;
  startSession(worktreePath: string, prompt: string): Promise<string>;
  waitForCompletion(sessionId: string): Promise<AdapterResult>;
  attach(sessionId: string): Promise<InteractiveSession>;
}

interface AdapterResult {
  success: boolean;
  exitCode: number;
  output: string;
  lastMessage: string;
}

interface InteractiveSession {
  send(message: string): Promise<void>;
  onOutput(callback: (chunk: string) => void): void;
  detach(): Promise<boolean>;
}
```

- **CLI subprocess interface** (ADR-0004). Adapters spawn the agent CLI as a child process. Completion detected via process exit code. JSON output parsed for results. Session resume flags used for Attach. No API/SDK dependency.

- **Automatic accept mode**. Adapters pass flags that disable all approval prompts (Devin: `--permission-mode auto-accept`, Codex: `--dangerously-bypass-approvals-and-sandbox`). Agents never block.

- **NPM package distribution with auto-discovery** (ADR-0003). Packages named `@orchestrator/adapter-<name>`. The orchestrator scans `node_modules` for matching packages.

- **Orchestrator owns commit + PR creation**. Adapters do NOT handle git commit or PR creation. This ensures uniform output across all agents.

### Planner

- **Dependencies are pre-declared upstream** — the Planner does NOT analyze dependencies. It reads them from Tickets (frontmatter `dependencies` field for local files, `<!-- deps: #12, #15 -->` blocks for GitHub issues).

- **Wave assignment is deterministic** — topological sort of the declared dependency graph. No LLM involved. Cycle detection errors clearly.

- **LLM used only for prompt generation and size assessment** — via a pluggable provider abstraction (Vercel AI SDK). Uses structured output / function calling. If a Ticket's frontmatter includes a `prompt` field, LLM generation is skipped.

- **Size warnings are non-blocking** — the Planner emits warnings for oversized Tickets, visible at the Approval Gate. The user decides whether to proceed.

### Ticket:Task Mapping

- **1:1 mapping** — each Ticket maps to exactly one Task. No splitting or merging. Ticket sizing is the upstream grilling workflow's responsibility.

### Execution Model

- **Wave-based execution** — Waves run sequentially. Within a Wave, Tasks run in parallel. Wave N+1 starts only after all Tasks in Wave N have completed.

- **Worktrees** — one per Task, created via `git worktree add`, branched from the Base Branch. Between Waves, completed PRs are merged into the Base Branch so Wave N+1 worktrees include prior work. Worktrees persist through the entire Run, cleaned up only after Completion.

- **Commit** — squash all agent commits into one clean commit per Task. Message derived from Ticket title and Task Prompt.

- **Pull Request** — one per Task. Body includes: Ticket reference, Task Prompt, agent's `lastMessage`, attach audit trail, Session reference. Branch naming: `orchestrator/<task-id>-<slug>`. Created via `gh` CLI (ADR-0008).

- **Merge** — auto-merge by default. Optional Merge Gate (configurable) requires user approval before merging between Waves. PRs merged sequentially; conflicts flagged as `conflicted`.

### Failure Handling

- **Independent failure** — a failed Task does not block other Tasks in the same Wave.
- **Blocked Tasks** — Tasks whose dependencies failed are marked `blocked`. They auto-unblock when the dependency is fixed and completes. User can manually unblock.
- **Merge Conflicts** — conflicting PRs flagged as `conflicted`, held for user intervention. Non-conflicting PRs proceed normally.

### Attach

- Available at any time during execution, not just after failure.
- Orchestrator is aware of attachment (no auto-timeout while attached).
- User messages logged in Run State as audit trail, included in PR body.
- On detach, orchestrator asks whether the issue was resolved.

### State Persistence

- **SQLite** (ADR-0002). Stores Dependency Graph, Wave assignments, Session IDs, Task Statuses, worktree paths.
- **Manual resume** — `orchestrator resume <run-id>` or `orchestrator resume --last`. No auto-resume. Orchestrator reconnects to running Sessions via stored session IDs.

### Configuration

- **Layered** — global (`~/.config/orchestrator/config.yml`) → repo-level (`.orchestrator/config.yml`) → CLI flags. Each layer overrides the one below.
- Covers: adapter selection, Base Branch, Merge Gate toggle, Planner LLM provider + model, Prompt Template path, Ticket Source settings.

### Ticket Sources

- **Built-in: GitHub and Local**. GitHub uses `gh` CLI to fetch issues. Local reads Markdown files with YAML frontmatter from a directory.
- **Extensible** — internal interface designed for adding new sources (Linear, Jira) later.
- **Normalization** — both sources normalize to a common Ticket shape before Planning.
- **Local file format** — Markdown with YAML frontmatter (`id`, `title`, `labels`, `dependencies`, optional `prompt`).
- **GitHub dependency format** — `<!-- deps: #12, #15 -->` block in issue body, written by the upstream grilling workflow.

### Approval Gate

- TUI review (Dashboard) with `$EDITOR` for content edits (Task Prompts). Adapter assignments and wave edits via TUI keypresses. Same pattern as `git commit` opening an editor.

### Per-Task Adapter Selection

- Default adapter from Config. Overridable per-Task at the Approval Gate. The Plan includes an Adapter assignment per Task.

## Testing Decisions

### What makes a good test

Tests should verify external behavior, not implementation details. A good test asserts what the user or external system observes (PRs created, task statuses, error messages), not how the code is structured internally. Tests should be resilient to refactoring — if you rename a private method, the tests should still pass.

### Seam 1: Orchestrator class (integration tests with injected fakes)

The `Orchestrator` class is the primary testing seam. All external dependencies are injected and can be replaced with fakes:

- **Fake Adapter** — implements the Adapter contract with configurable behavior (success/failure, delay, output). No real CLI subprocess spawned.
- **Fake Ticket Source** — returns predetermined Tickets from fixture data. No real `gh` calls or file reads.
- **Fake Planner LLM** — returns predetermined Task Prompts and size warnings. No real API calls.
- **Fake git/gh operations** — intercepts shell commands to `git` and `gh`, recording calls and returning configurable results. No real git operations.

Tests at this seam cover:
- Full Run lifecycle (Intake → Planning → Approval → Execution → Completion)
- Topological sort and wave assignment (deterministic, verifiable)
- Parallel session execution within waves
- Independent task failure (one failure doesn't block others)
- Blocked task auto-unblock when dependency is fixed
- Merge conflict detection and flagging
- Commit (squash) + PR creation flow
- Worktree creation and cleanup lifecycle
- Run State persistence and manual resume
- Attach message audit trail logging
- Per-task adapter selection
- Circular dependency detection

### Seam 2: Adapter contract (subprocess spawning tests)

Adapter implementations are tested with fixture-based fake CLI binaries:

- A fake CLI script that mimics the agent's interface (accepts the expected flags, produces JSON output, exits with configurable code)
- Tests verify the adapter passes the correct flags (automatic accept mode, working directory, prompt file)
- Tests verify the adapter correctly parses JSON output and extracts `lastMessage`
- Tests verify the adapter handles process exit codes correctly (success vs. failure)
- Tests verify the adapter handles session resume for Attach

### Prior art

This is a greenfield project — no existing tests. The dependency injection pattern used in the `Orchestrator` constructor (accepting `config`, `ticketSource`, `stateDbPath`) is the foundation for testability. The Adapter interface itself is the contract that enables faking.

## Out of Scope

- **Dependency analysis** — the Planner does not analyze dependencies between Tickets. Dependencies are pre-declared upstream by the grilling workflow. Building or integrating the grilling workflow is out of scope.
- **Ticket splitting or merging** — each Ticket maps 1:1 to a Task. The orchestrator does not decompose Tickets into smaller units or combine small Tickets.
- **Web dashboard** — the UI is terminal-only (CLI + Ink TUI). No web server.
- **Direct GitHub API integration** — all GitHub operations go through `gh` CLI. No Octokit or direct API calls.
- **Direct agent API/SDK integration** — all agent communication goes through CLI subprocess. No agent-specific APIs.
- **Automatic retry of failed Tasks** — failed Tasks are held for user intervention. The user decides whether to retry, not the orchestrator.
- **Automatic merge conflict resolution** — conflicted PRs are flagged for user intervention. No auto-resolution.
- **Task Manifest format** — dropped in favor of Tickets with frontmatter as the single input format. No separate manifest file.
- **Auto-resume on startup** — resume is explicit via CLI command.
- **New Ticket Sources** (Linear, Jira) — the interface is designed for extensibility, but only GitHub and Local sources are built.
- **Adapters beyond Devin and Codex** — the adapter contract and NPM distribution model support any agent, but only Devin and Codex adapters are built initially.

## Further Notes

- The domain glossary (`CONTEXT.md`) and 8 ADRs in `docs/adr/` are the authoritative source for terminology and architectural decisions. Any implementation should use the vocabulary defined there.
- The upstream grilling workflow is responsible for: producing well-sized Tickets, declaring dependencies between Tickets, and writing the `<!-- deps: ... -->` convention into GitHub issue bodies or `dependencies` fields in local file frontmatter.
- Prerequisites for using the tool: Node.js 20+, pnpm 9+, `gh` CLI (authenticated), and at least one agent CLI installed (Devin or Codex).
- The project is already scaffolded as a pnpm monorepo with all packages typechecking and building cleanly. The shared types package (`@orchestrator/types`) defines the Adapter contract, Ticket, Task, Plan, RunState, and Config types.
