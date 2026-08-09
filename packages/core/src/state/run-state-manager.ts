import type { RunState, Task, Plan, TaskStatus, AttachMessage } from "@orchestrator/types";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * RunStateManager — persists Run State to a JSON file on disk.
 *
 * Stores the Dependency Graph, Wave assignments, Session IDs, Task Statuses,
 * and worktree paths. On restart, the orchestrator reads Run State to reconnect
 * to running Sessions and resume execution (via explicit `resume` command).
 *
 * MVP: JSON file persistence. ADR-0002 calls for SQLite; this is a stepping
 * stone — the interface is identical, so the storage backend can be swapped
 * without touching callers.
 */
export class RunStateManager {
  private readonly statePath: string;
  private runs = new Map<string, RunState>();
  private tasks = new Map<string, Task[]>();

  constructor(statePath: string) {
    this.statePath = statePath;
    this.loadFromDisk();
  }

  initializeRun(plan: Plan): RunState {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    // Clone tasks so the plan remains immutable — execution mutates run state, not the plan
    const tasks: Task[] = plan.tasks.map((t) => ({ ...t, attachMessages: [...t.attachMessages] }));

    const run: RunState = {
      id: runId,
      phase: "approval",
      plan,
      currentWave: 0,
      tasks,
      startedAt: now,
      updatedAt: now,
    };

    this.runs.set(runId, run);
    this.tasks.set(runId, tasks);
    this.saveToDisk();
    return run;
  }

  getRun(runId: string): RunState | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    // Return a copy with the current tasks merged in (tasks are mutated separately)
    return { ...run, tasks: this.tasks.get(runId) ?? run.tasks };
  }

  getTasks(runId: string): Task[] {
    return this.tasks.get(runId) ?? [];
  }

  listRuns(): RunState[] {
    return Array.from(this.runs.values()).map((run) => ({
      ...run,
      tasks: this.tasks.get(run.id) ?? run.tasks,
    }));
  }

  updateRun(runId: string, updates: Partial<RunState>): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    Object.assign(run, updates, { updatedAt: new Date().toISOString() });
    this.saveToDisk();
  }

  updateTask(runId: string, taskId: string, updates: Partial<Task>): void {
    const tasks = this.tasks.get(runId);
    if (!tasks) throw new Error(`Run not found: ${runId}`);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    Object.assign(task, updates);
    this.saveToDisk();
  }

  addAttachMessage(runId: string, taskId: string, message: AttachMessage): void {
    const tasks = this.tasks.get(runId);
    if (!tasks) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.attachMessages.push(message);
    this.saveToDisk();
  }

  setTaskStatus(runId: string, taskId: string, status: TaskStatus): void {
    this.updateTask(runId, taskId, { status });
  }

  // -------------------------------------------------------------------------
  // Disk persistence (JSON MVP — SQLite per ADR-0002 is a future upgrade)
  // -------------------------------------------------------------------------

  private saveToDisk(): void {
    if (!this.statePath || this.statePath === ":memory:") return;

    const data: Record<string, { run: RunState; tasks: Task[] }> = {};
    for (const [runId, run] of this.runs) {
      data[runId] = { run, tasks: this.tasks.get(runId) ?? [] };
    }

    const dir = dirname(this.statePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(data, null, 2), "utf-8");
  }

  private loadFromDisk(): void {
    if (!this.statePath || this.statePath === ":memory:") return;
    if (!existsSync(this.statePath)) return;

    try {
      const data = JSON.parse(readFileSync(this.statePath, "utf-8")) as Record<string, { run: RunState; tasks: Task[] }>;
      for (const [runId, entry] of Object.entries(data)) {
        this.runs.set(runId, entry.run);
        this.tasks.set(runId, entry.tasks);
      }
    } catch {
      // Corrupt or unreadable state file — start fresh
    }
  }
}
