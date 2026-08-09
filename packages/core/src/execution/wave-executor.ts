import type { RunState, Task, AdapterResult } from "@orchestrator/types";
import type { AdapterRegistry } from "../adapter-registry/registry.js";
import type { RunStateManager } from "../state/run-state-manager.js";
import type { OrchestratorConfig } from "../config/config-loader.js";
import type { GitOperations } from "./git-operations.js";
import type { OrchestratorOptions } from "../orchestrator.js";

/**
 * Options for executing a single wave.
 */
export interface ExecuteWaveOptions {
  /** Maximum number of tasks to run concurrently within the wave. Default: unlimited. */
  maxParallelism?: number;
  /** Specific task IDs to run. If omitted, all runnable tasks in the wave are executed. */
  taskIds?: string[];
}

/**
 * WaveExecutor — executes waves and merges their results.
 *
 * The user-driven execution model (ADR-0008) splits execution into separate
 * steps the user controls:
 *   1. executeWave(runId, waveNum, options) — run tasks in a wave (with optional
 *      parallelism limit and task selection). Does NOT auto-advance or merge.
 *   2. mergeWave(runId, waveNum) — merge completed PRs from a wave.
 *   3. execute(runId) — convenience: run all remaining waves + merges (for `run` command).
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

  /**
   * Convenience: execute all remaining waves + merges sequentially.
   * Used by the `run` command. For user-driven execution, use executeWave + mergeWave.
   */
  async execute(runId: string): Promise<RunState> {
    const run = this.stateManager.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    for (let wave = run.currentWave; wave < run.plan!.waves.length; wave++) {
      await this.executeWave(runId, wave);
      await this.mergeWave(runId, wave);
      this.stateManager.updateRun(runId, { currentWave: wave + 1 });
    }

    this.stateManager.updateRun(runId, { phase: "completion" });
    await this.cleanupWorktrees(runId);
    return this.stateManager.getRun(runId)!;
  }

  async resume(runId: string): Promise<RunState> {
    const run = this.stateManager.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return this.execute(runId);
  }

  /**
   * Execute tasks in a specific wave. Does NOT merge or advance to the next wave.
   * The user calls mergeWave separately when they're ready.
   */
  async executeWave(runId: string, waveNum: number, options: ExecuteWaveOptions = {}): Promise<RunState> {
    const run = this.stateManager.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (waveNum < 0 || waveNum >= run.plan!.waves.length) {
      throw new Error(`Wave ${waveNum} does not exist (plan has ${run.plan!.waves.length} waves)`);
    }

    const waveTaskIds = run.plan!.waves[waveNum];
    let tasks = this.stateManager.getTasks(runId).filter((t) => waveTaskIds.includes(t.id));

    // Filter to selected task IDs if specified
    if (options.taskIds) {
      tasks = tasks.filter((t) => options.taskIds!.includes(t.id));
    }

    // Skip tasks that are already completed, failed, or conflicted
    const runnable = tasks.filter((t) => t.status !== "completed" && t.status !== "failed" && t.status !== "conflicted");

    if (runnable.length === 0) {
      this.onProgress(`Wave ${waveNum}: no tasks to run (all completed/failed).`);
      return this.stateManager.getRun(runId)!;
    }

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

    // Run sessions with optional parallelism limit
    const maxParallelism = options.maxParallelism ?? prepared.length;
    await this.runWithConcurrency(prepared, maxParallelism, ({ task, worktreePath }) =>
      this.runSession(runId, task, worktreePath),
    );

    return this.stateManager.getRun(runId)!;
  }

  /**
   * Merge completed PRs from a specific wave. The user calls this after
   * reviewing PRs on GitHub and deciding to merge.
   */
  async mergeWave(runId: string, waveNum: number): Promise<RunState> {
    const run = this.stateManager.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const waveTaskIds = run.plan!.waves[waveNum];
    const tasks = this.stateManager.getTasks(runId).filter((t) => waveTaskIds.includes(t.id));
    const completedWithPR = tasks.filter((t) => t.status === "completed" && t.prUrl);

    if (completedWithPR.length === 0) {
      this.onProgress(`Wave ${waveNum}: no completed PRs to merge.`);
      return this.stateManager.getRun(runId)!;
    }

    // Merge gate: ask the user whether to merge the PRs from this wave.
    if (this.config.mergeGate) {
      const summaries = completedWithPR.map((t) => `  ${t.id}: ${t.title} — ${t.prUrl}`);
      this.onProgress(`\n=== Merge Gate (Wave ${waveNum}) ===`);
      this.onProgress(`The following PRs are ready to merge:\n${summaries.join("\n")}`);
      this.onProgress(`Review them on GitHub before approving.`);

      const approved = await this.mergeGatePrompt(waveNum, summaries);
      if (!approved) {
        this.onProgress(`Merge gate declined — PRs left open for manual review.`);
        return this.stateManager.getRun(runId)!;
      }
      this.onProgress(`Merge gate approved — merging PRs...`);
    } else {
      // mergeGate disabled: leave PRs open, don't auto-merge
      this.onProgress(`\nPRs created (auto-merge disabled):`);
      for (const task of completedWithPR) {
        this.onProgress(`  ${task.id}: ${task.prUrl}`);
      }
      this.onProgress(`Review and merge manually on GitHub.\n`);
      return this.stateManager.getRun(runId)!;
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

    return this.stateManager.getRun(runId)!;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async runSession(runId: string, task: Task, worktreePath: string): Promise<void> {
    const adapter = this.adapterRegistry.getAdapter(task.adapter);
    const modelInfo = adapter.model ? ` (${task.adapter}, model: ${adapter.model})` : ` (${task.adapter})`;
    this.onProgress(`  [${task.id}] starting agent session${modelInfo}`);
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

  /**
   * Run async tasks with a concurrency limit. At most `limit` tasks run at once;
   * as each completes, the next queued task starts.
   */
  private async runWithConcurrency<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    let index = 0;
    const workers: Promise<void>[] = [];
    const workerCount = Math.min(limit, items.length);

    for (let w = 0; w < workerCount; w++) {
      workers.push(
        (async () => {
          while (index < items.length) {
            const currentIndex = index++;
            await fn(items[currentIndex]);
          }
        })(),
      );
    }

    await Promise.all(workers);
  }

  private async commitAndCreatePR(
    runId: string,
    task: Task,
    worktreePath: string,
    result: AdapterResult,
  ): Promise<void> {
    const commitMessage = `${task.title}\n\nTask: ${task.id}\nAdapter: ${task.adapter}`;
    await this.gitOps.commitAll(worktreePath, commitMessage);

    const branchName = this.branchName(task);
    await this.gitOps.push(worktreePath, branchName);

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
