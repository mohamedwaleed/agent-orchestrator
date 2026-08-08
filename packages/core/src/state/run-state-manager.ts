import type { RunState, Task, Plan, TaskStatus, AttachMessage } from "@orchestrator/types";

/**
 * RunStateManager — persists Run State in a local SQLite database.
 * Includes the Dependency Graph, Wave assignments, Session IDs, Task Statuses,
 * and worktree paths. On restart, the orchestrator reads Run State to reconnect
 * to running Sessions and resume execution (via explicit `resume` command).
 *
 * TODO: implement with better-sqlite3 or similar.
 * For now, this is an in-memory stub for scaffolding.
 */
export class RunStateManager {
  private runs = new Map<string, RunState>();
  private tasks = new Map<string, Task[]>();

  constructor(_dbPath: string) {}

  initializeRun(plan: Plan): RunState {
    const runId = `run-${Date.now()}`;
    const now = new Date().toISOString();

    const run: RunState = {
      id: runId,
      phase: "execution",
      plan,
      currentWave: 0,
      tasks: plan.tasks,
      startedAt: now,
      updatedAt: now,
    };

    this.runs.set(runId, run);
    this.tasks.set(runId, [...plan.tasks]);
    return run;
  }

  getRun(runId: string): RunState | undefined {
    return this.runs.get(runId);
  }

  getTasks(runId: string): Task[] {
    return this.tasks.get(runId) ?? [];
  }

  updateRun(runId: string, updates: Partial<RunState>): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    Object.assign(run, updates, { updatedAt: new Date().toISOString() });
  }

  updateTask(runId: string, taskId: string, updates: Partial<Task>): void {
    const tasks = this.tasks.get(runId);
    if (!tasks) throw new Error(`Run not found: ${runId}`);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    Object.assign(task, updates);
  }

  addAttachMessage(runId: string, taskId: string, message: AttachMessage): void {
    const tasks = this.tasks.get(runId);
    if (!tasks) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.attachMessages.push(message);
  }

  setTaskStatus(runId: string, taskId: string, status: TaskStatus): void {
    this.updateTask(runId, taskId, { status });
  }
}
