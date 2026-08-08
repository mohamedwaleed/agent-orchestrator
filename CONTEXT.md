# Agent Orchestrator

A local tool that takes tickets (GitHub issues or local files with pre-declared dependencies), assigns them to parallel waves, runs coding agents against each task in isolated git worktrees, and produces a PR per task.

## Language

**Ticket**:
A unit of work from an upstream source — a GitHub issue or a local file. The raw input the orchestrator consumes. Carries pre-declared dependencies (from the upstream grilling workflow) and optional metadata. Local file Tickets may include a `prompt` field in frontmatter to bypass the Planner's LLM prompt generation.
_Avoid_: Issue (reserved for the GitHub-specific artifact), Story, Task (reserved for the decomposed unit — see below)

**Task**:
A unit of work mapped 1:1 from a Ticket, designed to be executable in parallel with other Tasks that have no dependency on it. Each Task runs in its own worktree and produces its own PR.
_Avoid_: Job, Work item

**Planning**:
The process of reading pre-declared dependencies from Tickets, topologically sorting them into Waves, generating a Task Prompt for each, and assessing ticket size. Dependencies are declared upstream by the grilling workflow — the Planner does not analyze them. This is the "gap" the orchestrator fills between ticket intake and agent execution. Each Ticket maps to exactly one Task (1:1).
_Avoid_: Decomposition, Breakdown, Splitting

**Dependency Graph**:
The directed graph of Tasks built from pre-declared dependencies in the Tickets (not analyzed by the Planner). An edge from Task A to Task B means B depends on A. Used for deterministic wave assignment via topological sort.

**Wave**:
A group of Tasks in the Dependency Graph that have no unmet dependencies and can therefore run in parallel. The orchestrator executes Waves sequentially — Wave N+1 only starts after all Tasks in Wave N have completed.

**Adapter**:
A pluggable module that bridges the orchestrator to a specific coding agent (e.g., Devin, Codex, Claude). Its contract is limited to session lifecycle: start a session in a worktree with a task prompt, detect completion, and allow attaching to an active session. Adapters do NOT handle commit or PR creation — that is the orchestrator's responsibility, ensuring uniform output across all agents.

The Adapter contract specifies three operations:
1. `start_session(worktree_path, prompt) -> session_id` — launch the agent in the given worktree with the task prompt.
2. `wait_for_completion(session_id) -> Result` — a blocking call that returns when the agent finishes. The Adapter implementation chooses how to detect completion internally (polling, process exit, event listening, etc.). `Result` is `{ success: boolean, exitCode: number, output: string, lastMessage: string }` — the orchestrator uses `success` to decide commit+PR vs. failed, `lastMessage` for the PR body (agent's own summary), and `output` for diagnostics on failure.
3. `attach(session_id) -> interactive_session` — join an active session for real-time interaction. See Attach.

Adapters are distributed as NPM packages following the naming convention `@orchestrator/adapter-<name>`. The orchestrator auto-discovers installed adapter packages in `node_modules`. Users install a new adapter via `npm install @orchestrator/adapter-<name>` with no explicit registration required.

Adapters interface with agents via CLI subprocess — spawning the agent's CLI as a child process (e.g., `devin -p "prompt"`, `codex exec "prompt" -C /worktree/path --json`). Completion is detected via process exit code. JSON output is parsed for results. Session resume (e.g., `devin -r <session_id>`, `codex exec resume <session_id>`) is used for Attach. No API/SDK dependency — the Adapter is thin, mostly subprocess management and output parsing. This keeps the adapter contract universal: any agent with a CLI can be supported.

Agents always run in automatic accept mode — the Adapter passes flags that disable all approval prompts (e.g., Devin's `--permission-mode`, Codex's `--dangerously-bypass-approvals-and-sandbox`). Agents never block waiting for user interaction. The user's ability to influence the agent is through Attach, not through approval prompts.

_Avoid_: Driver, Connector, Integration

**Session**:
A running instance of an agent working on a Task within a worktree. Created by an Adapter, identifiable by a session ID, and attachable by the user for follow-up interaction.
_Avoid_: Run, Process

**Worktree**:
An isolated git worktree (via `git worktree add`) created for a single Task, branched from the latest state of the Base Branch. Provides filesystem-level isolation so parallel Tasks don't interfere with each other. Worktrees persist through the entire Run — the user can inspect them during execution and in the Intervention phase. They are cleaned up only after the Run is complete (all interventions resolved or abandoned).
_Avoid_: Clone, Branch (reserved for the git concept), Sandbox

**Base Branch**:
The branch that worktrees are created from and that completed Task PRs are merged back into. Typically `main` or `master`. Between Waves, the orchestrator merges completed PRs into the Base Branch so that the next Wave's worktrees include prior work.
_Avoid_: Trunk, Default branch

**Planner**:
The internal component of the orchestrator that produces a Plan. Responsibilities:
1. **Read pre-declared dependencies** from Tickets (declared upstream by the grilling workflow, not analyzed by the Planner).
2. **Assign Tickets to Waves** — deterministic topological sort of the declared dependency graph. No LLM involved.
3. **Generate Task Prompts** — uses the Planner LLM + codebase context (directory tree, key files) to produce context-aware prompts that reference relevant files and patterns.
4. **Assess ticket size** — uses the Planner LLM to emit non-blocking warnings for oversized tickets, visible at the Approval Gate.

The Planner does NOT analyze dependencies (that's done upstream), does NOT split or merge Tickets (1:1 mapping), and does NOT use the LLM for wave assignment (that's pure computation). The Planner is not an Adapter — it is a core orchestrator capability. Its output is always subject to user approval before execution.
_Avoid_: Decomposer, Analyzer

**Plan**:
The output of the Planner. Contains the Dependency Graph, Wave assignments, a Task Prompt for each Ticket, and an Adapter assignment per Task (defaulting to the Config default, overridable at the Approval Gate). Subject to user approval at the Approval Gate before execution begins.
_Avoid_: Task graph, Roadmap

**Approval Gate**:
The checkpoint between Planning and execution where the user reviews the proposed Plan, edits it if needed, and explicitly approves it. No Task begins running until the Approval Gate is passed. Review and navigation happen in the Dashboard TUI (view graph, waves, prompts, size warnings, adapter assignments). Content edits (e.g., modifying a Task Prompt) open the user's `$EDITOR` for a full editing experience, then return to the TUI. Adapter assignments and wave edits are done via TUI keypresses. Same pattern as `git commit` opening an editor for the commit message.
_Avoid_: Review, Checkpoint

**Task Status**:
The lifecycle state of a Task: `pending` (not yet started), `running` (agent session active), `completed` (agent finished, PR created), `failed` (agent finished without success or errored), `blocked` (dependencies not yet satisfied or a dependency failed), `conflicted` (PR merge into Base Branch conflicted with another Task's changes). Failed and Conflicted Tasks are held for user intervention and do not block other Tasks in the same Wave. Blocked Tasks are held until their dependencies are resolved — when a failed dependency is fixed (via attach/retry) and completes, the blocked Task automatically unblocks and runs in the next applicable Wave. The user can also manually unblock a Task if they decide the dependency failure is unrelated to its scope.
_Avoid_: State, Phase

**Attach**:
The act of the user joining an active Session at any time during execution — not just after failure. The user can observe the agent working in real time and send messages to command modifications to the code. While a user is attached, the orchestrator is aware of the attachment and adjusts its behavior (e.g., no auto-timeout). Messages sent by the user during attach are logged in Run State as an audit trail and included in the resulting PR body for reviewer context. On detach, the orchestrator asks the user whether the issue was resolved or the Task should be marked as failed. Attach is available from the Dashboard by selecting any running Session.
_Avoid_: Connect, Join

**Dashboard**:
A terminal UI (TUI) that shows all active and completed Sessions, their Task Statuses, streaming logs, and the current Wave. The user can select any Session from the Dashboard to Attach to it. Complements the CLI, which handles commands like running the orchestrator and specifying ticket sources.
_Avoid_: Monitor, View, UI

**Run**:
A single execution of the orchestrator from Intake to Completion. Phases:
1. **Intake** — fetch Tickets from a Ticket Source, present for selection.
2. **Planning** — the Planner reads pre-declared dependencies, topologically sorts Tickets into Waves, generates Task Prompts (LLM), assesses ticket size (LLM).
3. **Approval Gate** — user reviews and approves the Plan.
4. **Execution** — per Wave (sequential): create worktrees from Base Branch → start Sessions in parallel (automatic accept mode) → wait for completion → commit + create PR per Task → merge PRs into Base Branch (auto-merge or Merge Gate) → flag Merge Conflicts. The user can Attach to any running Session at any time during this phase. Worktrees persist through the entire Run and are cleaned up only after Completion.
5. **Completion** — report summary: completed PRs, failed Tasks, conflicted Tasks.
6. **Intervention** — asynchronous; user attaches to failed/conflicted Sessions, resolves issues, retries.
_Avoid_: Pipeline, Workflow

**Ticket Source**:
A provider from which Tickets are fetched. Built-in sources are GitHub (issues from a repo) and Local (files from a directory). The user specifies a source and optional filters; the orchestrator fetches matching Tickets and presents them for selection before Planning. The internal interface is designed to allow adding new sources (e.g., Linear, Jira) later without architectural change.

Local file Tickets are Markdown files with YAML frontmatter for metadata (`id`, `title`, `labels`, `dependencies`, optional `prompt`) and a Markdown body for the description. GitHub Tickets are mapped from GitHub issue structure (title, body, labels), with dependencies parsed from a structured convention in the issue body (e.g., a `<!-- deps: #12, #15 -->` block written by the upstream grilling workflow). Both are normalized to a common Ticket shape before Planning.
_Avoid_: Connector, Provider, Feed

**Merge Gate**:
An optional checkpoint between Waves where the user must review and approve the merging of completed PRs into the Base Branch before the next Wave's worktrees are created. When disabled (default), the orchestrator auto-merges completed PRs. When enabled, it provides a safety checkpoint for high-stakes task graphs.
_Avoid_: Review gate, Approval (reserved for the Approval Gate before execution)

**Task Prompt**:
The instruction string passed to an Adapter's `start_session` call. Constructed by the Planner from the original Ticket content, relevant codebase context, scope boundaries, and constraints. Rendered through a user-editable Prompt Template so project-specific conventions and agent-specific directives can be injected. If the Ticket's frontmatter includes a `prompt` field, the Planner skips LLM generation and uses that prompt directly.
_Avoid_: Instruction, Brief

**Prompt Template**:
A user-editable template that controls how Task Prompts are assembled. Combines ticket content, codebase context, and task constraints with user-defined directives (e.g., coding standards, file scope restrictions, agent-specific instructions). Provides the customization seam that makes the tool practical for real projects.
_Avoid_: Prompt config, Template

**Run State**:
The persistent record of an orchestration Run, stored in a local SQLite database. Includes the Dependency Graph, Wave assignments, Session IDs, Task Statuses, and worktree paths. On restart, the orchestrator does NOT auto-resume — the user explicitly runs `orchestrator resume <run-id>` or `orchestrator resume --last`. The orchestrator then reads Run State, reconnects to running Sessions via Adapter `wait_for_completion` (using stored session IDs), and continues from where the Run was interrupted.
_Avoid_: State file, Snapshot

**Config**:
Layered configuration for the orchestrator. Three layers, each overriding the one below: global config (`~/.config/orchestrator/config.yml`) for user-wide defaults, repo-level config (`.orchestrator/config.yml`) for team-shared settings, and CLI flags for one-off overrides. Covers adapter selection, ticket source settings, prompt templates, merge gate toggle, base branch, and Planner LLM settings (provider + model).
_Avoid_: Settings, Preferences

**Planner LLM**:
The language model used by the Planner for Task Prompt generation and ticket size assessment. Configured via a pluggable provider abstraction (e.g., Vercel AI SDK) that supports multiple providers (OpenAI, Anthropic, local models via Ollama, etc.). The user selects provider and model in Config. Uses structured output / function calling for machine-readable output, not free-text. Not used for dependency analysis or wave assignment (those are deterministic).
_Avoid_: Planner model, AI backend

**Merge Conflict**:
A situation where two Tasks in the same Wave modified overlapping files, causing their PRs to conflict when merged sequentially into the Base Branch. The conflicting PR is flagged as `conflicted` and held for user intervention. The user can resolve the conflict manually or attach to a new session to have the agent redo its work against the updated Base Branch. Other non-conflicting PRs in the Wave proceed normally.
_Avoid_: Collision, Clash

**Commit**:
The orchestrator's git commit step after a Session completes. Squashes all commits the agent made during the Session into a single clean commit with a message derived from the Ticket title and Task Prompt. Ensures uniform, reviewable history across all PRs regardless of which agent produced them.
_Avoid_: Squash commit, Final commit

**Pull Request**:
The PR created by the orchestrator after committing. One per Task. The PR body includes: the original Ticket reference, the Task Prompt, the agent's `lastMessage` (from the Adapter Result — the agent's own summary of what it did), any user modification messages logged during Attach (as an audit trail), and a reference to the Session. Branch naming follows a convention (e.g., `orchestrator/<task-id>-<slug>`) to distinguish orchestrator-generated PRs from manual ones. All GitHub operations (reading issues, creating PRs, merging PRs) are performed via the `gh` CLI — the orchestrator shells out to `gh`, which handles authentication and API calls. No direct GitHub API dependency in the orchestrator. `gh` is a prerequisite.
_Avoid_: Merge request, PR (acceptable shorthand)
