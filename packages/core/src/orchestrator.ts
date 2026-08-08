import type { RunState, Plan, Task, Ticket } from "@orchestrator/types";
import { Planner } from "./planner/planner.js";
import { WaveExecutor } from "./execution/wave-executor.js";
import { AdapterRegistry } from "./adapter-registry/registry.js";
import { RunStateManager } from "./state/run-state-manager.js";
import type { OrchestratorConfig } from "./config/config-loader.js";
import type { TicketSource } from "./ticket-source/ticket-source.js";

/**
 * The Orchestrator — coordinates the full Run lifecycle:
 * Intake → Planning → Approval Gate → Execution → Completion → Intervention
 */
export class Orchestrator {
  private stateManager: RunStateManager;
  private planner: Planner;
  private waveExecutor: WaveExecutor;
  private adapterRegistry: AdapterRegistry;

  constructor(
    config: OrchestratorConfig,
    private ticketSource: TicketSource,
    stateDbPath: string,
  ) {
    this.stateManager = new RunStateManager(stateDbPath);
    this.planner = new Planner(config);
    this.adapterRegistry = new AdapterRegistry();
    this.waveExecutor = new WaveExecutor(this.adapterRegistry, this.stateManager, config);
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
   * Phase 4: Execution — run waves sequentially, parallel tasks within each wave.
   * The user can attach to any running session at any time.
   */
  async execute(runId: string): Promise<RunState> {
    return this.waveExecutor.execute(runId);
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
