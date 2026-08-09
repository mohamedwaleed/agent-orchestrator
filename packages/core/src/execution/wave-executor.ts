import type { RunState, Task, AdapterResult } from "@orchestrator/types";
import type { AdapterRegistry } from "../adapter-registry/registry.js";
import type { RunStateManager } from "../state/run-state-manager.js";
import type { OrchestratorConfig } from "../config/config-loader.js";
import type { GitOperations } from "./git-operations.js";
import type { OrchestratorOptions } from "../orchestrator.js";

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
  private readonly mergeGatePrompt: (wave: number, taskSummaries: string[]) => Promise<boolean>;
  private readonly onProgress: (message: string) => void;

  constructor(
    private adapterRegistry: AdapterRegistry,
    private stateManager: RunStateManager,
    private config: OrchestratorConfig,
    private gitOps: GitOperations,
    options: OrchestratorOptions = {},
  ) {
    this.mergeGatePrompt = options.mergeGatePrompt ?? defaultMergeGatePrompt;
    this.onProgress = options.onProgress ?? ((msg: string) => console.log(msg));
  }

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
    const runnable = tasks.filter((t) => t.status !== "completed" && t.status !== "failed");

    this.onProgress(`--- Wave ${waveNum}: ${runnable.map((t) => t.id).join(", ")} ---`);

    // Create worktrees sequentially — git worktree metadata is not safe under
    // concurrent `git worktree add` operations against the same repo.
    const prepared: Array<{ task: Task; worktreePath: string }> = [];
    for (const task of runnable) {
      const branchName = this.branchName(task);
      const worktreePath = `.orchestrator/worktrees/${task.id}`;
      this.onProgress(`  [${task.id}] creating worktree on branch ${branchName}`);
      await this.gitOps.createWorktree(branchName, worktreePath, this.config.baseBranch);
      this.stateManager.updateTask(runId, task.id, { worktreePath, status: "running" });
      prepared.push({ task, worktreePath });
    }

    // Start sessions in parallel (automatic accept mode) and wait for completion
    await Promise.all(prepared.map(({ task, worktreePath }) => this.runSession(runId, task, worktreePath)));
  }

  private async runSession(runId: string, task: Task, worktreePath: string): Promise<void> {
    const adapter = this.adapterRegistry.getAdapter(task.adapter);
    this.onProgress(`  [${task.id}] starting agent session (${task.adapter})`);
    const sessionId = await adapter.startSession(worktreePath, task.prompt);
    this.stateManager.updateTask(runId, task.id, { sessionId });

    this.onProgress(`  [${task.id}] agent working...`);
    const result = await adapter.waitForCompletion(sessionId);

    if (result.success) {
      await this.commitAndCreatePR(runId, task, worktreePath, result);
      this.stateManager.updateTask(runId, task.id, { status: "completed" });
      const taskAfter = this.stateManager.getTasks(runId).find((t) => t.id === task.id);
      this.onProgress(`  [${task.id}] completed — PR: ${taskAfter?.prUrl ?? "(none)"}`);
    } else {
      this.stateManager.updateTask(runId, task.id, { status: "failed" });
      this.onProgress(`  [${task.id}] FAILED (exit code ${result.exitCode})`);
      if (result.output) {
        const lastLines = result.output.trim().split("\n").slice(-5).join("\n");
        this.onProgress(`  [${task.id}] last output:\n${lastLines}`);
      }
    }
  }

  private async commitAndCreatePR(
    runId: string,
    task: Task,
    worktreePath: string,
    result: AdapterResult,
  ): Promise<void> {
    // Stage all changes and squash into one commit
    const commitMessage = `${task.title}\n\nTask: ${task.id}\nAdapter: ${task.adapter}`;
    await this.gitOps.commitAll(worktreePath, commitMessage);

    // Push the branch
    const branchName = this.branchName(task);
    await this.gitOps.push(worktreePath, branchName);

    // Create PR via gh CLI
    const prBody = this.buildPRBody(task, result);
    const pr = await this.gitOps.createPR(task.title, prBody, this.config.baseBranch, branchName);

    this.stateManager.updateTask(runId, task.id, { prUrl: pr.url, prNumber: pr.number });
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
    const completedWithPR = tasks.filter((t) => t.status === "completed" && t.prUrl);

    if (completedWithPR.length === 0) return;

    // Merge gate: ask the user whether to merge the PRs from this wave.
    // In tracer-bullet mode (mergeGate disabled), PRs are left open for human review.
    if (this.config.mergeGate) {
      const summaries = completedWithPR.map((t) => `  ${t.id}: ${t.title} — ${t.prUrl}`);
      this.onProgress(`\n=== Merge Gate (Wave ${waveNum}) ===`);
      this.onProgress(`The following PRs are ready to merge:\n${summaries.join("\n")}`);
      this.onProgress(`Review them on GitHub before approving.`);

      const approved = await this.mergeGatePrompt(waveNum, summaries);
      if (!approved) {
        this.onProgress(`Merge gate declined — PRs left open for manual review.`);
        return;
      }
      this.onProgress(`Merge gate approved — merging PRs...`);
    } else {
      // mergeGate disabled: leave PRs open, don't auto-merge
      this.onProgress(`\nPRs created (auto-merge disabled):`);
      for (const task of completedWithPR) {
        this.onProgress(`  ${task.id}: ${task.prUrl}`);
      }
      this.onProgress(`Review and merge manually on GitHub.\n`);
      return;
    }

    for (const task of completedWithPR) {
      try {
        await this.gitOps.mergePR(task.prUrl!);
        this.onProgress(`  [${task.id}] merged: ${task.prUrl}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.stateManager.updateTask(runId, task.id, { status: "conflicted", conflictReason: reason });
        this.onProgress(`  [${task.id}] CONFLICTED — merge failed: ${reason}`);
        this.onProgress(`    PR: ${task.prUrl}`);
        this.onProgress(`    Resolve the conflict on GitHub, then merge manually.`);
      }
    }
  }

  private async cleanupWorktrees(runId: string): Promise<void> {
    const tasks = this.stateManager.getTasks(runId);
    for (const task of tasks) {
      if (task.worktreePath) {
        try {
          await this.gitOps.removeWorktree(task.worktreePath);
        } catch {
          // Worktree may already be removed
        }
      }
    }
  }

  /** Branch naming convention: orchestrator/<task-id>-<slug> */
  private branchName(task: Task): string {
    const slug = slugify(task.title);
    return `orchestrator/${task.id}-${slug}`;
  }
}

/** Convert a title to a URL-safe slug. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/**
 * Default merge gate prompt — reads from stdin. Used in production when no
 * custom prompt is injected. In tests, a fake prompt is injected instead.
 */
async function defaultMergeGatePrompt(wave: number, _summaries: string[]): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const { stdin, stdout } = process;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`Merge Wave ${wave} PRs into the base branch? [y/N] `);
    return answer.trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}
