#!/usr/bin/env node
import { Orchestrator } from "./orchestrator.js";
import { RealGitOperations } from "./execution/real-git-operations.js";
import type { GitOperations } from "./execution/git-operations.js";
import { LocalTicketSource } from "./ticket-source/local-source.js";
import { GitHubTicketSource } from "./ticket-source/github-source.js";
import { StubAdapter } from "./adapter-registry/stub-adapter.js";
import { CodexAdapter } from "@orchestrator/adapter-codex";
import { ConfigLoader } from "./config/config-loader.js";
import type { OrchestratorConfig } from "@orchestrator/types";

/**
 * NoPrGitOperations — wraps RealGitOperations but skips commit, push, PR, and merge.
 * Used with --no-pr to test execution (worktree creation, adapter sessions) without
 * creating real PRs. Worktree creation and cleanup still run.
 */
class NoPrGitOperations implements GitOperations {
  constructor(private inner: GitOperations) {}

  async createWorktree(branchName: string, worktreePath: string, baseBranch: string): Promise<void> {
    await this.inner.createWorktree(branchName, worktreePath, baseBranch);
  }

  async commitAll(_worktreePath: string, _message: string): Promise<void> {
    console.log("  [--no-pr] skipping commit");
  }

  async push(_worktreePath: string, _branchName: string): Promise<void> {
    console.log("  [--no-pr] skipping push");
  }

  async createPR(_title: string, _body: string, _baseBranch: string, _headBranch: string): Promise<{ url: string; number: number }> {
    console.log("  [--no-pr] skipping PR creation");
    return { url: "(skipped)", number: 0 };
  }

  async mergePR(_prUrl: string): Promise<void> {
    console.log("  [--no-pr] skipping PR merge");
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    await this.inner.removeWorktree(worktreePath);
  }
}

const STATE_PATH = ".orchestrator/state.json";

/**
 * CLI entry point for the Agent Orchestrator.
 *
 * Commands:
 *   orchestrator run --source <local|github> <ref> [options]  — full auto: plan + execute all waves
 *   orchestrator plan --source <local|github> <ref> [options] — intake + plan, save state, show waves
 *   orchestrator status [--last | <run-id>]                   — show current run state
 *   orchestrator execute-wave <wave> [options] [--run <id>]   — execute tasks in a wave
 *   orchestrator merge-wave <wave> [--run <id>]               — merge completed PRs from a wave
 *   orchestrator continue [--run <id>]                        — execute the next pending wave
 *   orchestrator resume <run-id>                              — resume an interrupted run
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "run") {
    await runCommand(args.slice(1));
  } else if (command === "plan") {
    await planCommand(args.slice(1));
  } else if (command === "status") {
    await statusCommand(args.slice(1));
  } else if (command === "execute-wave") {
    await executeWaveCommand(args.slice(1));
  } else if (command === "merge-wave") {
    await mergeWaveCommand(args.slice(1));
  } else if (command === "continue") {
    await continueCommand(args.slice(1));
  } else if (command === "resume") {
    console.error("resume is not yet implemented");
    process.exit(1);
  } else {
    printUsage();
    process.exit(1);
  }
}

// -------------------------------------------------------------------------
// Shared helpers
// -------------------------------------------------------------------------

function createOrchestrator(config: OrchestratorConfig, noPr: boolean): Orchestrator {
  let ticketSource;
  if (config.ticketSource.kind === "local") {
    ticketSource = new LocalTicketSource(config.ticketSource.ref);
  } else {
    ticketSource = new GitHubTicketSource(config.ticketSource.ref, config.ticketSource.filter);
  }

  const adapters = [new StubAdapter(), new CodexAdapter()];
  const gitOps: GitOperations = noPr
    ? new NoPrGitOperations(new RealGitOperations())
    : new RealGitOperations();

  return new Orchestrator(config, ticketSource, gitOps, adapters, STATE_PATH, {
    onProgress: (msg) => console.log(msg),
  });
}

function loadConfig(parsed: ParsedArgs): OrchestratorConfig {
  const configLoader = new ConfigLoader();
  const overrides: Partial<OrchestratorConfig> = {};
  if (parsed.adapter) overrides.adapter = parsed.adapter;
  if (parsed.baseBranch) overrides.baseBranch = parsed.baseBranch;
  if (parsed.ticketSource) overrides.ticketSource = parsed.ticketSource;
  if (parsed.mergeGate !== undefined) overrides.mergeGate = parsed.mergeGate;
  if (parsed.plannerProvider) overrides.plannerProvider = parsed.plannerProvider;
  if (parsed.plannerModel) overrides.plannerModel = parsed.plannerModel;
  if (parsed.promptTemplatePath) overrides.promptTemplatePath = parsed.promptTemplatePath;
  return configLoader.load(overrides);
}

/** Find the most recent run from persisted state. */
function getLastRunId(): string | undefined {
  const configLoader = new ConfigLoader();
  const config = configLoader.load();
  const orch = createOrchestrator(config, false);
  const runs = orch.listRuns();
  if (runs.length === 0) return undefined;
  // Sort by startedAt descending
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return runs[0].id;
}

function resolveRunId(parsed: ParsedArgs): string {
  if (parsed.runId) return parsed.runId;
  if (parsed.last) {
    const id = getLastRunId();
    if (!id) {
      console.error("No runs found. Use `orchestrator plan` to create one.");
      process.exit(1);
    }
    return id;
  }
  console.error("Error: --run <id> or --last is required");
  console.error("Use `orchestrator status --last` to find your run ID.");
  process.exit(1);
}

// -------------------------------------------------------------------------
// Commands
// -------------------------------------------------------------------------

async function runCommand(args: string[]): Promise<void> {
  const parsed = parseRunArgs(args);
  const config = loadConfig(parsed);
  const orchestrator = createOrchestrator(config, parsed.noPr ?? false);

  // Phase 1: Intake
  console.log("Fetching tickets...");
  const tickets = await orchestrator.intake();
  if (tickets.length === 0) {
    console.log("No tickets found.");
    return;
  }
  console.log(`Found ${tickets.length} ticket(s):`);
  for (const ticket of tickets) {
    console.log(`  - [${ticket.id}] ${ticket.title}`);
  }

  // Phase 2: Planning
  console.log("\nPlanning...");
  const plan = await orchestrator.plan(tickets);
  console.log(`Plan: ${plan.waves.length} wave(s)`);
  for (let i = 0; i < plan.waves.length; i++) {
    console.log(`  Wave ${i}: ${plan.waves[i].join(", ")}`);
  }

  // Phase 3: Approval Gate (auto-approve for tracer bullet)
  console.log("\nAuto-approving plan (no Approval Gate in tracer bullet mode)...");
  const runState = await orchestrator.approve(plan);
  console.log(`Run ID: ${runState.id}`);

  // Phase 4: Execution (all waves)
  console.log("\nExecuting...");
  const finalState = await orchestrator.execute(runState.id);

  // Phase 5: Completion
  printCompletionSummary(finalState);
}

async function planCommand(args: string[]): Promise<void> {
  const parsed = parseRunArgs(args);
  const config = loadConfig(parsed);
  const orchestrator = createOrchestrator(config, parsed.noPr ?? false);

  console.log("Fetching tickets...");
  const tickets = await orchestrator.intake();
  if (tickets.length === 0) {
    console.log("No tickets found.");
    return;
  }
  console.log(`Found ${tickets.length} ticket(s):`);
  for (const ticket of tickets) {
    console.log(`  - [${ticket.id}] ${ticket.title}`);
  }

  console.log("\nPlanning...");
  const plan = await orchestrator.plan(tickets);
  console.log(`\nPlan: ${plan.waves.length} wave(s)`);
  for (let i = 0; i < plan.waves.length; i++) {
    console.log(`  Wave ${i}: ${plan.waves[i].join(", ")}`);
  }

  // Show tasks per wave
  for (let i = 0; i < plan.waves.length; i++) {
    const waveTasks = plan.tasks.filter((t) => t.wave === i);
    console.log(`\n  Wave ${i} tasks:`);
    for (const task of waveTasks) {
      const deps = task.dependencies.length > 0 ? ` (depends: ${task.dependencies.join(", ")})` : "";
      console.log(`    [${task.id}] ${task.title}${deps}`);
    }
  }

  const runState = await orchestrator.approve(plan);
  console.log(`\nRun ID: ${runState.id}`);
  console.log(`\nNext steps:`);
  console.log(`  orchestrator execute-wave 0 --run ${runState.id} [--max-parallelism N] [--tasks id1,id2]`);
  console.log(`  orchestrator status --run ${runState.id}`);
}

async function statusCommand(args: string[]): Promise<void> {
  const parsed = parseStatusArgs(args);

  if (parsed.last) {
    const id = getLastRunId();
    if (!id) {
      console.log("No runs found.");
      return;
    }
    printRunStatus(id);
    return;
  }

  if (parsed.runId) {
    printRunStatus(parsed.runId);
    return;
  }

  // No run ID — list all runs
  const configLoader = new ConfigLoader();
  const config = configLoader.load();
  const orchestrator = createOrchestrator(config, false);
  const runs = orchestrator.listRuns();
  if (runs.length === 0) {
    console.log("No runs found.");
    return;
  }
  console.log(`Runs (${runs.length}):`);
  for (const run of runs) {
    const completed = run.tasks.filter((t) => t.status === "completed").length;
    const failed = run.tasks.filter((t) => t.status === "failed").length;
    const pending = run.tasks.filter((t) => t.status === "pending").length;
    const conflicted = run.tasks.filter((t) => t.status === "conflicted").length;
    console.log(`  ${run.id} [${run.phase}] — ${completed} completed, ${pending} pending, ${failed} failed, ${conflicted} conflicted (started ${run.startedAt})`);
  }
}

async function executeWaveCommand(args: string[]): Promise<void> {
  const parsed = parseWaveArgs(args);
  const runId = resolveRunId(parsed);
  const configLoader = new ConfigLoader();
  const config = loadConfig(parsed);
  const orchestrator = createOrchestrator(config, parsed.noPr ?? false);

  const waveNum = parsed.wave;
  if (waveNum === undefined) {
    console.error("Error: wave number is required");
    console.error("Usage: orchestrator execute-wave <wave> [--run <id> | --last] [--max-parallelism N] [--tasks id1,id2]");
    process.exit(1);
  }

  console.log(`Executing wave ${waveNum} for run ${runId}...`);
  const options: { maxParallelism?: number; taskIds?: string[] } = {};
  if (parsed.maxParallelism !== undefined) options.maxParallelism = parsed.maxParallelism;
  if (parsed.taskIds) options.taskIds = parsed.taskIds;

  const finalState = await orchestrator.executeWave(runId, waveNum, options);
  printCompletionSummary(finalState);
}

async function mergeWaveCommand(args: string[]): Promise<void> {
  const parsed = parseWaveArgs(args);
  const runId = resolveRunId(parsed);
  const configLoader = new ConfigLoader();
  const config = loadConfig(parsed);
  const orchestrator = createOrchestrator(config, false);

  const waveNum = parsed.wave;
  if (waveNum === undefined) {
    console.error("Error: wave number is required");
    console.error("Usage: orchestrator merge-wave <wave> [--run <id> | --last]");
    process.exit(1);
  }

  console.log(`Merging wave ${waveNum} for run ${runId}...`);
  const finalState = await orchestrator.mergeWave(runId, waveNum);
  printCompletionSummary(finalState);
}

async function continueCommand(args: string[]): Promise<void> {
  const parsed = parseContinueArgs(args);
  const runId = resolveRunId(parsed);
  const configLoader = new ConfigLoader();
  const config = loadConfig(parsed);
  const orchestrator = createOrchestrator(config, parsed.noPr ?? false);

  // Find the next wave that has pending tasks
  const run = orchestrator.getRunState(runId);
  if (!run) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }
  if (!run.plan) {
    console.error("Run has no plan.");
    process.exit(1);
  }

  // Find the next wave with pending tasks
  let nextWave = -1;
  for (let i = 0; i < run.plan.waves.length; i++) {
    const waveTasks = run.tasks.filter((t) => run.plan!.waves[i].includes(t.id));
    if (waveTasks.some((t) => t.status === "pending")) {
      nextWave = i;
      break;
    }
  }

  if (nextWave === -1) {
    console.log("No pending tasks remaining. All waves are done.");
    console.log("Use `orchestrator merge-wave <wave> --run <id>` to merge any unmerged PRs.");
    return;
  }

  console.log(`Continuing with wave ${nextWave} for run ${runId}...`);
  const finalState = await orchestrator.executeWave(runId, nextWave);
  printCompletionSummary(finalState);
}

// -------------------------------------------------------------------------
// Status printing
// -------------------------------------------------------------------------

function printRunStatus(runId: string): void {
  const configLoader = new ConfigLoader();
  const config = configLoader.load();
  const orchestrator = createOrchestrator(config, false);
  const run = orchestrator.getRunState(runId);
  if (!run) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }

  console.log(`Run: ${run.id}`);
  console.log(`Phase: ${run.phase}`);
  console.log(`Current wave: ${run.currentWave}`);
  console.log(`Started: ${run.startedAt}`);
  console.log(`\nTasks (${run.tasks.length}):`);
  for (const task of run.tasks) {
    const status = task.status.toUpperCase().padEnd(12);
    const pr = task.prUrl ? ` — ${task.prUrl}` : "";
    const conflict = task.conflictReason ? ` — ${task.conflictReason}` : "";
    console.log(`  [${task.id}] ${status} ${task.title}${pr}${conflict}`);
  }

  // Show wave summary
  if (run.plan) {
    console.log(`\nWaves (${run.plan.waves.length}):`);
    for (let i = 0; i < run.plan.waves.length; i++) {
      const waveTasks = run.tasks.filter((t) => run.plan!.waves[i].includes(t.id));
      const statuses = waveTasks.map((t) => t.status).join(", ");
      console.log(`  Wave ${i}: [${statuses}]`);
    }
  }
}

function printCompletionSummary(finalState: { phase: string; tasks: Array<{ status: string; id: string; title: string; prUrl?: string; conflictReason?: string }> }): void {
  console.log("\n=== Completion Summary ===");
  const completed = finalState.tasks.filter((t) => t.status === "completed");
  const failed = finalState.tasks.filter((t) => t.status === "failed");
  const conflicted = finalState.tasks.filter((t) => t.status === "conflicted");
  const pending = finalState.tasks.filter((t) => t.status === "pending");

  if (completed.length > 0) {
    console.log(`\nCompleted (${completed.length}):`);
    for (const task of completed) {
      console.log(`  - [${task.id}] ${task.title}`);
      if (task.prUrl) console.log(`    PR: ${task.prUrl}`);
    }
  }
  if (failed.length > 0) {
    console.log(`\nFailed (${failed.length}):`);
    for (const task of failed) {
      console.log(`  - [${task.id}] ${task.title}`);
    }
  }
  if (conflicted.length > 0) {
    console.log(`\nConflicted (${conflicted.length}):`);
    for (const task of conflicted) {
      console.log(`  - [${task.id}] ${task.title}`);
      if (task.prUrl) console.log(`    PR: ${task.prUrl}`);
      if (task.conflictReason) console.log(`    Reason: ${task.conflictReason}`);
      console.log(`    Action: Resolve the conflict on GitHub, then merge manually.`);
    }
  }
  if (pending.length > 0) {
    console.log(`\nPending (${pending.length}):`);
    for (const task of pending) {
      console.log(`  - [${task.id}] ${task.title}`);
    }
    console.log(`\nNext: orchestrator continue --run ${finalState.phase === "completion" ? "(run complete)" : "<run-id>"}`);
  }
}

// -------------------------------------------------------------------------
// Arg parsing
// -------------------------------------------------------------------------

interface ParsedArgs {
  adapter?: string;
  baseBranch?: string;
  mergeGate?: boolean;
  plannerProvider?: string;
  plannerModel?: string;
  promptTemplatePath?: string;
  ticketSource?: OrchestratorConfig["ticketSource"];
  noPr?: boolean;
  runId?: string;
  last?: boolean;
  wave?: number;
  maxParallelism?: number;
  taskIds?: string[];
}

function parseRunArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  parseCommonArgs(args, parsed);
  if (!parsed.ticketSource) {
    console.error("Error: --source is required");
    console.error("Usage: orchestrator run --source local <directory> [options]");
    process.exit(1);
  }
  return parsed;
}

function parseStatusArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--last") {
      parsed.last = true;
    } else if (args[i] === "--run" && i + 1 < args.length) {
      parsed.runId = args[i + 1];
      i++;
    } else if (!args[i].startsWith("--")) {
      parsed.runId = args[i];
    }
  }
  return parsed;
}

function parseWaveArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--run" && i + 1 < args.length) {
      parsed.runId = args[i + 1];
      i++;
    } else if (arg === "--last") {
      parsed.last = true;
    } else if (arg === "--max-parallelism" && i + 1 < args.length) {
      parsed.maxParallelism = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--tasks" && i + 1 < args.length) {
      parsed.taskIds = args[i + 1].split(",").map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (arg === "--no-pr") {
      parsed.noPr = true;
    } else if (arg === "--adapter" && i + 1 < args.length) {
      parsed.adapter = args[i + 1];
      i++;
    } else if (arg === "--base-branch" && i + 1 < args.length) {
      parsed.baseBranch = args[i + 1];
      i++;
    } else if (arg === "--merge-gate") {
      parsed.mergeGate = true;
    } else if (arg === "--no-merge-gate") {
      parsed.mergeGate = false;
    } else if (!arg.startsWith("--")) {
      parsed.wave = parseInt(arg, 10);
    }
  }
  return parsed;
}

function parseContinueArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--run" && i + 1 < args.length) {
      parsed.runId = args[i + 1];
      i++;
    } else if (arg === "--last") {
      parsed.last = true;
    } else if (arg === "--max-parallelism" && i + 1 < args.length) {
      parsed.maxParallelism = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--no-pr") {
      parsed.noPr = true;
    } else if (arg === "--adapter" && i + 1 < args.length) {
      parsed.adapter = args[i + 1];
      i++;
    } else if (arg === "--base-branch" && i + 1 < args.length) {
      parsed.baseBranch = args[i + 1];
      i++;
    } else if (arg === "--merge-gate") {
      parsed.mergeGate = true;
    } else if (arg === "--no-merge-gate") {
      parsed.mergeGate = false;
    }
  }
  return parsed;
}

function parseCommonArgs(args: string[], parsed: ParsedArgs): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--source" && i + 1 < args.length) {
      const sourceKind = args[i + 1];
      if (sourceKind === "local" && i + 2 < args.length) {
        parsed.ticketSource = { kind: "local", ref: args[i + 2] };
        i += 2;
      } else if (sourceKind === "github" && i + 2 < args.length) {
        parsed.ticketSource = { kind: "github", ref: args[i + 2] };
        i += 2;
      } else {
        console.error(`Unknown source: ${sourceKind}`);
        process.exit(1);
      }
    } else if (arg === "--adapter" && i + 1 < args.length) {
      parsed.adapter = args[i + 1];
      i++;
    } else if (arg === "--base-branch" && i + 1 < args.length) {
      parsed.baseBranch = args[i + 1];
      i++;
    } else if (arg === "--merge-gate") {
      parsed.mergeGate = true;
    } else if (arg === "--no-merge-gate") {
      parsed.mergeGate = false;
    } else if (arg === "--planner-provider" && i + 1 < args.length) {
      parsed.plannerProvider = args[i + 1];
      i++;
    } else if (arg === "--planner-model" && i + 1 < args.length) {
      parsed.plannerModel = args[i + 1];
      i++;
    } else if (arg === "--prompt-template" && i + 1 < args.length) {
      parsed.promptTemplatePath = args[i + 1];
      i++;
    } else if (arg === "--label" && i + 1 < args.length) {
      if (parsed.ticketSource) {
        parsed.ticketSource.filter = args[i + 1];
      }
      i++;
    } else if (arg === "--no-pr") {
      parsed.noPr = true;
    }
  }
}

function printUsage(): void {
  console.log(`Agent Orchestrator — user-driven parallel coding agent execution

Usage:
  orchestrator plan --source <local|github> <ref> [options]
    Fetch tickets and create a wave plan. Saves run state for later commands.

  orchestrator status [--last | <run-id>]
    Show the current state of a run (tasks, waves, PRs, conflicts).

  orchestrator execute-wave <wave> [--run <id> | --last] [options]
    Execute tasks in a specific wave. Does NOT merge or advance.
    --max-parallelism N   Limit concurrent sessions to N
    --tasks id1,id2       Run only specific tasks from the wave

  orchestrator merge-wave <wave> [--run <id> | --last]
    Merge completed PRs from a wave (after reviewing them on GitHub).

  orchestrator continue [--run <id> | --last]
    Execute the next wave that has pending tasks.

  orchestrator run --source <local|github> <ref> [options]
    Full auto: plan + execute all waves + merge. (Tracer bullet mode.)

  orchestrator resume <run-id>
    Resume an interrupted run.

Common options:
  --adapter <name>           Adapter to use (default: from config)
  --base-branch <name>       Base branch for worktrees and PRs (default: main)
  --merge-gate               Enable the merge gate between waves (default: true)
  --no-merge-gate            Disable the merge gate — PRs are left open for manual review
  --label <label>            Filter GitHub issues by label
  --no-pr                    Run execution but skip commit, push, PR, and merge

Typical user-driven flow:
  1. orchestrator plan --source github owner/repo --adapter codex
  2. orchestrator execute-wave 0 --last --max-parallelism 2
  3. (review PRs on GitHub)
  4. orchestrator merge-wave 0 --last
  5. orchestrator continue --last
  6. (repeat 2-5 until done)
`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
