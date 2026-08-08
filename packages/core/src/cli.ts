#!/usr/bin/env node
import { Orchestrator } from "./orchestrator.js";
import { RealGitOperations } from "./execution/real-git-operations.js";
import { LocalTicketSource } from "./ticket-source/local-source.js";
import { GitHubTicketSource } from "./ticket-source/github-source.js";
import { StubAdapter } from "./adapter-registry/stub-adapter.js";
import { ConfigLoader } from "./config/config-loader.js";
import type { OrchestratorConfig } from "@orchestrator/types";

/**
 * CLI entry point for the Agent Orchestrator.
 *
 * Usage:
 *   orchestrator run --source local ./tickets/
 *   orchestrator run --source github owner/repo [--label parallelizable]
 *   orchestrator resume <run-id>
 *   orchestrator resume --last
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "run") {
    await runCommand(args.slice(1));
  } else if (command === "resume") {
    console.error("resume is not yet implemented");
    process.exit(1);
  } else {
    printUsage();
    process.exit(1);
  }
}

async function runCommand(args: string[]): Promise<void> {
  const parsed = parseRunArgs(args);
  const configLoader = new ConfigLoader();

  // Only pass defined values so undefined doesn't override config defaults
  const overrides: Partial<OrchestratorConfig> = {};
  if (parsed.adapter) overrides.adapter = parsed.adapter;
  if (parsed.baseBranch) overrides.baseBranch = parsed.baseBranch;
  if (parsed.ticketSource) overrides.ticketSource = parsed.ticketSource;
  if (parsed.mergeGate !== undefined) overrides.mergeGate = parsed.mergeGate;
  if (parsed.plannerProvider) overrides.plannerProvider = parsed.plannerProvider;
  if (parsed.plannerModel) overrides.plannerModel = parsed.plannerModel;
  if (parsed.promptTemplatePath) overrides.promptTemplatePath = parsed.promptTemplatePath;

  const mergedConfig = configLoader.load(overrides);

  // Select ticket source
  let ticketSource;
  if (mergedConfig.ticketSource.kind === "local") {
    ticketSource = new LocalTicketSource(mergedConfig.ticketSource.ref);
  } else {
    ticketSource = new GitHubTicketSource(mergedConfig.ticketSource.ref, mergedConfig.ticketSource.filter);
  }

  // For the tracer bullet, use the stub adapter
  const adapters = [new StubAdapter()];
  const gitOps = new RealGitOperations();

  const orchestrator = new Orchestrator(
    mergedConfig,
    ticketSource,
    gitOps,
    adapters,
    ".orchestrator/state.db",
  );

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

  // Phase 4: Execution
  console.log("\nExecuting...");
  const finalState = await orchestrator.execute(runState.id);

  // Phase 5: Completion
  console.log("\n=== Completion Summary ===");
  const completed = finalState.tasks.filter((t) => t.status === "completed");
  const failed = finalState.tasks.filter((t) => t.status === "failed");
  const conflicted = finalState.tasks.filter((t) => t.status === "conflicted");

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
    }
  }
}

interface ParsedArgs {
  adapter?: string;
  baseBranch?: string;
  mergeGate?: boolean;
  plannerProvider?: string;
  plannerModel?: string;
  promptTemplatePath?: string;
  ticketSource?: OrchestratorConfig["ticketSource"];
}

function parseRunArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};

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
    }
  }

  if (!parsed.ticketSource) {
    console.error("Error: --source is required");
    console.error("Usage: orchestrator run --source local ./tickets/");
    process.exit(1);
  }

  return parsed;
}

function printUsage(): void {
  console.log(`Agent Orchestrator — parallel coding agent execution

Usage:
  orchestrator run --source local <directory> [options]
  orchestrator run --source github <owner/repo> [--label <label>] [options]
  orchestrator resume <run-id>
  orchestrator resume --last

Options:
  --adapter <name>           Adapter to use (default: from config)
  --base-branch <name>       Base branch for worktrees and PRs (default: main)
  --merge-gate               Enable the merge gate between waves (default: false)
  --no-merge-gate            Disable the merge gate (overrides config)
  --planner-provider <name>  Planner LLM provider (default: from config)
  --planner-model <name>     Planner LLM model (default: from config)
  --prompt-template <path>   Path to prompt template file (default: from config)
  --label <label>            Filter GitHub issues by label
`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
