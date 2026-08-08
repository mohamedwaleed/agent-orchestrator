import type { Ticket, Task, Plan } from "@orchestrator/types";
import type { OrchestratorConfig } from "../config/config-loader.js";

/**
 * The Planner — produces a Plan from Tickets.
 *
 * Responsibilities:
 * 1. Read pre-declared dependencies from Tickets (not analyzed — done upstream)
 * 2. Assign Tickets to Waves — deterministic topological sort (no LLM)
 * 3. Generate Task Prompts — uses Planner LLM + codebase context
 * 4. Assess ticket size — uses Planner LLM for non-blocking warnings
 *
 * Does NOT: analyze dependencies, split/merge tickets, or use LLM for wave assignment.
 */
export class Planner {
  constructor(private config: OrchestratorConfig) {}

  async createPlan(tickets: Ticket[]): Promise<Plan> {
    const dependencyGraph = this.buildDependencyGraph(tickets);
    const waves = this.topologicalSort(dependencyGraph);
    const tasks = await this.createTasks(tickets, waves, dependencyGraph);

    return {
      tasks,
      dependencyGraph,
      waves,
      baseBranch: this.config.baseBranch,
    };
  }

  /**
   * Build an adjacency list from pre-declared ticket dependencies.
   */
  private buildDependencyGraph(tickets: Ticket[]): Record<string, string[]> {
    const graph: Record<string, string[]> = {};
    for (const ticket of tickets) {
      graph[ticket.id] = ticket.dependencies;
    }
    return graph;
  }

  /**
   * Deterministic topological sort — assigns tasks to waves.
   * Wave 0 = tasks with no dependencies. Wave N = tasks whose dependencies
   * are all in waves 0..N-1.
   */
  private topologicalSort(graph: Record<string, string[]>): string[][] {
    const waves: string[][] = [];
    const assigned = new Set<string>();
    const allIds = Object.keys(graph);

    while (assigned.size < allIds.length) {
      const wave: string[] = [];
      for (const id of allIds) {
        if (assigned.has(id)) continue;
        const deps = graph[id] ?? [];
        if (deps.every((dep) => assigned.has(dep))) {
          wave.push(id);
        }
      }
      if (wave.length === 0) {
        // Cycle detected — remaining tasks have circular dependencies
        throw new Error(
          `Circular dependency detected among tasks: ${allIds.filter((id) => !assigned.has(id)).join(", ")}`,
        );
      }
      for (const id of wave) {
        assigned.add(id);
      }
      waves.push(wave);
    }

    return waves;
  }

  /**
   * Create Task objects from Tickets + wave assignments.
   * Uses LLM for prompt generation (unless ticket has a pre-written prompt)
   * and size assessment.
   */
  private async createTasks(
    tickets: Ticket[],
    waves: string[][],
    graph: Record<string, string[]>,
  ): Promise<Task[]> {
    const ticketMap = new Map(tickets.map((t) => [t.id, t]));
    const tasks: Task[] = [];

    for (let waveNum = 0; waveNum < waves.length; waveNum++) {
      for (const ticketId of waves[waveNum]) {
        const ticket = ticketMap.get(ticketId);
        if (!ticket) continue;

        const prompt = ticket.prompt ?? (await this.generatePrompt(ticket));
        const sizeWarning = await this.assessSize(ticket);

        tasks.push({
          id: ticketId,
          ticketId: ticketId,
          title: ticket.title,
          prompt,
          dependencies: graph[ticketId] ?? [],
          wave: waveNum,
          adapter: this.config.adapter,
          status: "pending",
          sizeWarning: sizeWarning ?? undefined,
          attachMessages: [],
        });
      }
    }

    return tasks;
  }

  /**
   * Generate a context-aware task prompt using the Planner LLM.
   * TODO: implement with Vercel AI SDK + codebase context (directory tree, key files).
   */
  private async generatePrompt(ticket: Ticket): Promise<string> {
    // Placeholder — will be implemented with the LLM provider abstraction
    return `Implement: ${ticket.title}\n\n${ticket.body}`;
  }

  /**
   * Assess ticket size — emit a non-blocking warning if the ticket seems too large.
   * TODO: implement with the Planner LLM.
   */
  private async assessSize(_ticket: Ticket): Promise<string | null> {
    // Placeholder — will be implemented with the LLM provider abstraction
    return null;
  }
}
