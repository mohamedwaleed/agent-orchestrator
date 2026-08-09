import type { RunState, Plan, Task, Ticket, Adapter } from "@orchestrator/types";
import { Planner } from "./planner/planner.js";
import { WaveExecutor } from "./execution/wave-executor.js";
import { AdapterRegistry } from "./adapter-registry/registry.js";
import { RunStateManager } from "./state/run-state-manager.js";
import type { OrchestratorConfig } from "./config/config-loader.js";
import type { TicketSource } from "./ticket-source/ticket-source.js";
import type { GitOperations } from "./execution/git-operations.js";

/**
 * Optional hooks for controlling the orchestrator's interactive behavior.
 * In production these default to real stdin/console prompts. In tests they
 * are injected with fakes.
 */
export interface OrchestratorOptions {
  /** Called at the merge gate between waves. Returns true to merge, false to leave PRs open. */
  mergeGatePrompt?: (wave: number, taskSummaries: string[]) => Promise<boolean>;
  /** Called for each progress event during execution (wave start, task start, etc.). */
  onProgress?: (message: string) => void;
}

/**
 * The Orchestrator — coordinates the full Run lifecycle:
 * Intake → Planning → Approval Gate → Execution → Completion → Intervention
 *
 * All external dependencies are injected for testability:
 * - ticketSource: where tickets come from (GitHub, local, or fake)
 * - gitOps: git/gh operations (real or fake)
 * - adapters: agent adapters (real or stub)
 */
export class Orchestrator {
  private stateManager: RunStateManager;
  private planner: Planner;
  private waveExecutor: WaveExecutor;
  private adapterRegistry: AdapterRegistry;

  constructor(
    config: OrchestratorConfig,
    private ticketSource: TicketSource,
    gitOps: GitOperations,
    adapters: Adapter[],
    stateDbPath: string,
    options: OrchestratorOptions = {},
  ) {
    this.stateManager = new RunStateManager(stateDbPath);
    this.planner = new Planner(config);
    this.adapterRegistry = new AdapterRegistry();
    for (const adapter of adapters) {
      this.adapterRegistry.register(adapter);
    }
    this.waveExecutor = new WaveExecutor(
      this.adapterRegistry, this.stateManager, config, gitOps, options,
    );
  }

  /**
   * Phase 1: Intake — fetch tickets from the source and present for selection.
   */
  async intake(): Promise<Ticket[]> {
    const tickets = await this.ticketSource.fetch();
    return tickets;
  }

  /**
   * Phase 2: Planning — the Planner reads dependencies, sorts into waves,
   * generates task prompts (LLM), and assesses ticket size.
   */
  async plan(tickets: Ticket[]): Promise<Plan> {
    return this.planner.createPlan(tickets);
  }

  /**
   * Phase 3: Approval Gate — user reviews and approves the plan.
   * This is handled by the TUI; the orchestrator just waits for the approved plan.
   */
  async approve(plan: Plan): Promise<RunState> {
    return this.stateManager.initializeRun(plan);
  }

  /**
   * Phase 4: Execution — run all remaining waves + merges sequentially.
   * This is the convenience method for the `run` command. For user-driven
   * execution, use executeWave + mergeWave instead.
   */
  async execute(runId: string): Promise<RunState> {
    return this.waveExecutor.execute(runId);
  }

  /**
   * Execute tasks in a specific wave. Does NOT merge or advance to the next wave.
   * Options:
   *   - maxParallelism: limit concurrent sessions within the wave
   *   - taskIds: run only specific tasks from the wave
   */
  async executeWave(runId: string, waveNum: number, options?: {
    maxParallelism?: number;
    taskIds?: string[];
  }): Promise<RunState> {
    return this.waveExecutor.executeWave(runId, waveNum, options);
  }

  /**
   * Merge completed PRs from a specific wave. The user calls this after
   * reviewing PRs on GitHub and deciding to merge.
   */
  async mergeWave(runId: string, waveNum: number): Promise<RunState> {
    return this.waveExecutor.mergeWave(runId, waveNum);
  }

  /**
   * List all persisted runs (for the `status` command).
   */
  listRuns(): RunState[] {
    return this.stateManager.listRuns();
  }

  /**
   * Resume an interrupted Run — reads Run State, reconnects to sessions, continues.
   */
  async resume(runId: string): Promise<RunState> {
    return this.waveExecutor.resume(runId);
  }

  /**
   * Get the current state of a Run (for the Dashboard).
   */
  getRunState(runId: string): RunState | undefined {
    return this.stateManager.getRun(runId);
  }

  /**
   * Get all tasks for a Run (for the Dashboard).
   */
  getTasks(runId: string): Task[] {
    return this.stateManager.getTasks(runId);
  }
}
