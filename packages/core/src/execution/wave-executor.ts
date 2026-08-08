import type { RunState, Task, AdapterResult } from "@orchestrator/types";
import type { AdapterRegistry } from "../adapter-registry/registry.js";
import type { RunStateManager } from "../state/run-state-manager.js";
import type { OrchestratorConfig } from "../config/config-loader.js";
import { exec as execChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const exec = promisify(execChildProcess);

/**
 * WaveExecutor — executes waves sequentially, parallel tasks within each wave.
 *
 * Per wave:
 * 1. Create worktrees from Base Branch
 * 2. Start sessions in parallel (automatic accept mode)
 * 3. Wait for completion
 * 4. Commit + create PR per task
 * 5. Merge PRs into Base Branch (auto-merge or Merge Gate)
 * 6. Flag merge conflicts
 *
 * Worktrees persist through the entire Run — cleaned up only after completion.
 */
export class WaveExecutor {
  constructor(
    private adapterRegistry: AdapterRegistry,
    private stateManager: RunStateManager,
    private config: OrchestratorConfig,
  ) {}

  async execute(runId: string): Promise<RunState> {
    const run = this.stateManager.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    for (let wave = run.currentWave; wave < run.plan!.waves.length; wave++) {
      await this.executeWave(runId, wave);
      await this.mergeWaveResults(runId, wave);
      this.stateManager.updateRun(runId, { currentWave: wave + 1 });
    }

    this.stateManager.updateRun(runId, { phase: "completion" });
    await this.cleanupWorktrees(runId);
    return this.stateManager.getRun(runId)!;
  }

  async resume(runId: string): Promise<RunState> {
    const run = this.stateManager.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    // Reconnect to running sessions and continue from current wave
    return this.execute(runId);
  }

  private async executeWave(runId: string, waveNum: number): Promise<void> {
    const run = this.stateManager.getRun(runId)!;
    const waveTaskIds = run.plan!.waves[waveNum];
    const tasks = this.stateManager.getTasks(runId).filter((t) => waveTaskIds.includes(t.id));

    // Create worktrees and start sessions in parallel
    const sessionPromises: Promise<void>[] = [];
    for (const task of tasks) {
      if (task.status === "completed" || task.status === "failed") continue;
      sessionPromises.push(this.runTask(runId, task));
    }
    await Promise.all(sessionPromises);
  }

  private async runTask(runId: string, task: Task): Promise<void> {
    const worktreePath = await this.createWorktree(task.id);
    this.stateManager.updateTask(runId, task.id, {
      worktreePath,
      status: "running",
    });

    const adapter = this.adapterRegistry.getAdapter(task.adapter);
    const sessionId = await adapter.startSession(worktreePath, task.prompt);
    this.stateManager.updateTask(runId, task.id, { sessionId });

    const result = await adapter.waitForCompletion(sessionId);

    if (result.success) {
      await this.commitAndCreatePR(runId, task, worktreePath, result);
      this.stateManager.updateTask(runId, task.id, { status: "completed" });
    } else {
      this.stateManager.updateTask(runId, task.id, { status: "failed" });
    }
  }

  private async createWorktree(taskId: string): Promise<string> {
    const branchName = `orchestrator/${taskId}`;
    const worktreePath = join(".orchestrator/worktrees", taskId);
    await exec(`git worktree add -b ${branchName} ${worktreePath} ${this.config.baseBranch}`);
    return worktreePath;
  }

  private async commitAndCreatePR(
    runId: string,
    task: Task,
    worktreePath: string,
    result: AdapterResult,
  ): Promise<void> {
    // Stage all changes and squash into one commit
    await exec(`git -C ${worktreePath} add -A`);
    const commitMessage = `${task.title}\n\nTask: ${task.id}\nAdapter: ${task.adapter}`;
    await exec(`git -C ${worktreePath} commit -m "${commitMessage.replace(/"/g, '\\"')}"`);

    // Push the branch
    const branchName = `orchestrator/${task.id}`;
    await exec(`git -C ${worktreePath} push -u origin ${branchName}`);

    // Create PR via gh CLI
    const prBody = this.buildPRBody(task, result);
    const { stdout } = await exec(
      `gh pr create --title "${task.title.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}" --base ${this.config.baseBranch} --head ${branchName}`,
    );
    const prUrl = stdout.trim();

    this.stateManager.updateTask(runId, task.id, { prUrl });
  }

  private buildPRBody(task: Task, result: AdapterResult): string {
    const parts: string[] = [
      `## Summary`,
      result.lastMessage,
      "",
      `## Task`,
      `**Ticket:** ${task.ticketId}`,
      `**Prompt:** ${task.prompt}`,
    ];

    if (task.attachMessages.length > 0) {
      parts.push("", `## User Modifications (during attach)`);
      for (const msg of task.attachMessages) {
        parts.push(`- [${msg.timestamp}] ${msg.message}`);
      }
    }

    parts.push("", `---`, `Generated by Agent Orchestrator`);
    return parts.join("\n");
  }

  private async mergeWaveResults(runId: string, waveNum: number): Promise<void> {
    const run = this.stateManager.getRun(runId)!;
    const waveTaskIds = run.plan!.waves[waveNum];
    const tasks = this.stateManager.getTasks(runId).filter((t) => waveTaskIds.includes(t.id));

    for (const task of tasks) {
      if (task.status !== "completed" || !task.prUrl) continue;

      if (this.config.mergeGate) {
        // TODO: pause and wait for user approval via TUI
      }

      try {
        await exec(`gh pr merge ${task.prUrl} --squash --delete-branch`);
      } catch {
        // Merge conflict — flag for user intervention
        this.stateManager.updateTask(runId, task.id, { status: "conflicted" });
      }
    }
  }

  private async cleanupWorktrees(runId: string): Promise<void> {
    const tasks = this.stateManager.getTasks(runId);
    for (const task of tasks) {
      if (task.worktreePath) {
        try {
          await exec(`git worktree remove --force ${task.worktreePath}`);
        } catch {
          // Worktree may already be removed
        }
      }
    }
  }
}
