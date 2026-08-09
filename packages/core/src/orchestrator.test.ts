import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Ticket, Adapter, AdapterResult, InteractiveSession, OrchestratorConfig } from "@orchestrator/types";
import { Orchestrator } from "./orchestrator.js";
import type { GitOperations } from "./execution/git-operations.js";
import type { TicketSource } from "./ticket-source/ticket-source.js";

// ---------------------------------------------------------------------------
// Fakes for injected dependencies — test at the Orchestrator seam
// ---------------------------------------------------------------------------

/** Fake ticket source that returns predetermined tickets. */
class FakeTicketSource implements TicketSource {
  constructor(private tickets: Ticket[]) {}
  async fetch(): Promise<Ticket[]> {
    return [...this.tickets];
  }
}

/** Fake adapter that returns success with a fake lastMessage. */
class FakeAdapter implements Adapter {
  readonly name = "stub";
  startSessionCalled = false;
  waitForCompletionCalled = false;

  async startSession(_worktreePath: string, _prompt: string): Promise<string> {
    this.startSessionCalled = true;
    return "fake-session-1";
  }

  async waitForCompletion(_sessionId: string): Promise<AdapterResult> {
    this.waitForCompletionCalled = true;
    return {
      success: true,
      exitCode: 0,
      output: "Fake adapter output",
      lastMessage: "Fake adapter: task completed with no real changes.",
    };
  }

  async attach(_sessionId: string): Promise<InteractiveSession> {
    throw new Error("Not supported in fake");
  }
}

/** Records every git/gh operation call and returns configurable results. */
interface RecordedCall {
  method: string;
  args: unknown[];
}

class FakeGitOperations implements GitOperations {
  calls: RecordedCall[] = [];
  prUrl = "https://github.com/owner/repo/pull/1";
  prNumber = 1;
  mergeShouldFail = false;
  mergeErrorMessage = "Merge conflict";

  async createWorktree(branchName: string, worktreePath: string, baseBranch: string): Promise<void> {
    this.calls.push({ method: "createWorktree", args: [branchName, worktreePath, baseBranch] });
  }

  async commitAll(worktreePath: string, message: string): Promise<void> {
    this.calls.push({ method: "commitAll", args: [worktreePath, message] });
  }

  async push(worktreePath: string, branchName: string): Promise<void> {
    this.calls.push({ method: "push", args: [worktreePath, branchName] });
  }

  async createPR(title: string, body: string, baseBranch: string, headBranch: string): Promise<{ url: string; number: number }> {
    this.calls.push({ method: "createPR", args: [title, body, baseBranch, headBranch] });
    return { url: this.prUrl, number: this.prNumber };
  }

  async mergePR(prUrl: string): Promise<void> {
    this.calls.push({ method: "mergePR", args: [prUrl] });
    if (this.mergeShouldFail) throw new Error(this.mergeErrorMessage);
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    this.calls.push({ method: "removeWorktree", args: [worktreePath] });
  }
}

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    adapter: "stub",
    baseBranch: "main",
    mergeGate: false,
    plannerProvider: "openai",
    plannerModel: "gpt-4o",
    ticketSource: { kind: "local", ref: "./tickets" },
    ...overrides,
  };
}

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "TICKET-001",
    source: "local",
    title: "Add hello world endpoint",
    body: "Create a simple GET /hello endpoint that returns 'world'.",
    labels: [],
    dependencies: [],
    sourceRef: "./tickets/001.md",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Orchestrator — single-ticket end-to-end (tracer bullet)", () => {
  it("runs a single ticket from intake to PR creation", async () => {
    // Arrange — inject all fakes
    const ticket = makeTicket();
    const ticketSource = new FakeTicketSource([ticket]);
    const adapter = new FakeAdapter();
    const gitOps = new FakeGitOperations();
    // Explicitly disable merge gate for this tracer bullet test
    const config = makeConfig({ mergeGate: false });
    const orchestrator = new Orchestrator(config, ticketSource, gitOps, [adapter], ":memory:");

    // Act — run the full lifecycle
    const tickets = await orchestrator.intake();
    const plan = await orchestrator.plan(tickets);
    const runState = await orchestrator.approve(plan);
    const finalState = await orchestrator.execute(runState.id);

    // Assert — intake fetched the ticket
    expect(tickets).toHaveLength(1);
    expect(tickets[0].id).toBe("TICKET-001");

    // Assert — planning produced a single wave with one task
    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0]).toContain("TICKET-001");
    expect(plan.tasks).toHaveLength(1);
    const task = plan.tasks[0];
    expect(task.wave).toBe(0);
    expect(task.status).toBe("pending");
    expect(task.prompt).toContain("Add hello world endpoint");
    expect(task.prompt).toContain("Create a simple GET /hello endpoint");
    expect(task.adapter).toBe("stub");

    // Assert — the adapter was invoked
    expect(adapter.startSessionCalled).toBe(true);
    expect(adapter.waitForCompletionCalled).toBe(true);

    // Assert — a worktree was created from the base branch
    const createWtCall = gitOps.calls.find((c) => c.method === "createWorktree");
    expect(createWtCall).toBeDefined();
    expect(createWtCall!.args[0]).toMatch(/^orchestrator\/TICKET-001-/);
    expect(createWtCall!.args[2]).toBe("main");

    // Assert — changes were committed with a message derived from the ticket title
    const commitCall = gitOps.calls.find((c) => c.method === "commitAll");
    expect(commitCall).toBeDefined();
    expect(commitCall!.args[1]).toContain("Add hello world endpoint");

    // Assert — a PR was created with a structured body
    const prCall = gitOps.calls.find((c) => c.method === "createPR");
    expect(prCall).toBeDefined();
    expect(prCall!.args[0]).toBe("Add hello world endpoint");
    const prBody = prCall!.args[1] as string;
    expect(prBody).toContain("Fake adapter: task completed with no real changes.");
    expect(prBody).toContain("TICKET-001");
    expect(prBody).toContain("Add hello world endpoint");

    // Assert — branch naming follows orchestrator/<task-id>-<slug>
    const pushCall = gitOps.calls.find((c) => c.method === "push");
    expect(pushCall!.args[1]).toBe("orchestrator/TICKET-001-add-hello-world-endpoint");
    expect(prCall!.args[3]).toBe("orchestrator/TICKET-001-add-hello-world-endpoint");

    // Assert — with mergeGate disabled, PR is created but NOT auto-merged
    // (left open for human review)
    const mergeCall = gitOps.calls.find((c) => c.method === "mergePR");
    expect(mergeCall).toBeUndefined();

    // Assert — worktree was cleaned up
    const removeCall = gitOps.calls.find((c) => c.method === "removeWorktree");
    expect(removeCall).toBeDefined();

    // Assert — final state shows completion
    expect(finalState.phase).toBe("completion");
    const finalTask = finalState.tasks.find((t) => t.id === "TICKET-001");
    expect(finalTask).toBeDefined();
    expect(finalTask!.status).toBe("completed");
    expect(finalTask!.prUrl).toBe("https://github.com/owner/repo/pull/1");
    expect(finalTask!.prNumber).toBe(1);
    expect(finalTask!.sessionId).toBe("fake-session-1");
    expect(finalTask!.worktreePath).toBe(".orchestrator/worktrees/TICKET-001");
  });

  it("marks the task as failed when the adapter returns failure", async () => {
    const ticket = makeTicket();
    const ticketSource = new FakeTicketSource([ticket]);

    // Adapter that fails
    const failingAdapter: Adapter = {
      name: "stub",
      async startSession() { return "fake-session-fail"; },
      async waitForCompletion(): Promise<AdapterResult> {
        return { success: false, exitCode: 1, output: "Error: something went wrong", lastMessage: "" };
      },
      async attach() { throw new Error("Not supported"); },
    };

    const gitOps = new FakeGitOperations();
    const orchestrator = new Orchestrator(makeConfig({ mergeGate: false }), ticketSource, gitOps, [failingAdapter], ":memory:");

    const tickets = await orchestrator.intake();
    const plan = await orchestrator.plan(tickets);
    const runState = await orchestrator.approve(plan);
    const finalState = await orchestrator.execute(runState.id);

    const finalTask = finalState.tasks.find((t) => t.id === "TICKET-001");
    expect(finalTask!.status).toBe("failed");

    // No PR should have been created
    const prCall = gitOps.calls.find((c) => c.method === "createPR");
    expect(prCall).toBeUndefined();
  });

  it("detects circular dependencies and errors clearly", async () => {
    const ticketA = makeTicket({ id: "A", dependencies: ["B"] });
    const ticketB = makeTicket({ id: "B", dependencies: ["A"] });
    const ticketSource = new FakeTicketSource([ticketA, ticketB]);
    const orchestrator = new Orchestrator(
      makeConfig(),
      ticketSource,
      new FakeGitOperations(),
      [new FakeAdapter()],
      ":memory:",
    );

    const tickets = await orchestrator.intake();
    await expect(orchestrator.plan(tickets)).rejects.toThrow(/Circular dependency/);
  });
});

describe("Orchestrator — parallel tasks in a single wave", () => {
  it("creates worktrees sequentially within a wave (git worktree metadata is not concurrency-safe)", async () => {
    // Three independent tickets → all land in Wave 0
    const tickets = [
      makeTicket({ id: "T1", title: "Task one" }),
      makeTicket({ id: "T2", title: "Task two" }),
      makeTicket({ id: "T3", title: "Task three" }),
    ];
    const ticketSource = new FakeTicketSource(tickets);
    const adapter = new FakeAdapter();

    // Fake that detects concurrent createWorktree calls
    const gitOps = new SequentialDetectingGitOperations();
    const orchestrator = new Orchestrator(makeConfig({ mergeGate: false }), ticketSource, gitOps, [adapter], ":memory:");

    const fetched = await orchestrator.intake();
    const plan = await orchestrator.plan(fetched);
    expect(plan.waves[0]).toHaveLength(3); // all in one wave

    const runState = await orchestrator.approve(plan);
    await orchestrator.execute(runState.id);

    expect(gitOps.concurrentWorktreeError).toBeUndefined();
  });
});

describe("Orchestrator — merge gate", () => {
  it("does not merge PRs when mergeGate is enabled and the user declines", async () => {
    const ticket = makeTicket();
    const ticketSource = new FakeTicketSource([ticket]);
    const adapter = new FakeAdapter();
    const gitOps = new FakeGitOperations();
    const config = makeConfig({ mergeGate: true });

    // User declines the merge gate — PRs should stay open, not be merged
    const orchestrator = new Orchestrator(
      config, ticketSource, gitOps, [adapter], ":memory:",
      { mergeGatePrompt: async () => false },
    );

    const tickets = await orchestrator.intake();
    const plan = await orchestrator.plan(tickets);
    const runState = await orchestrator.approve(plan);
    const finalState = await orchestrator.execute(runState.id);

    // PR was created but NOT merged
    const prCall = gitOps.calls.find((c) => c.method === "createPR");
    expect(prCall).toBeDefined();
    const mergeCall = gitOps.calls.find((c) => c.method === "mergePR");
    expect(mergeCall).toBeUndefined();

    // Task is still completed (PR exists), just not merged
    const task = finalState.tasks.find((t) => t.id === "TICKET-001");
    expect(task!.status).toBe("completed");
  });

  it("merges PRs when mergeGate is enabled and the user approves", async () => {
    const ticket = makeTicket();
    const ticketSource = new FakeTicketSource([ticket]);
    const adapter = new FakeAdapter();
    const gitOps = new FakeGitOperations();
    const config = makeConfig({ mergeGate: true });

    const orchestrator = new Orchestrator(
      config, ticketSource, gitOps, [adapter], ":memory:",
      { mergeGatePrompt: async () => true },
    );

    const tickets = await orchestrator.intake();
    const plan = await orchestrator.plan(tickets);
    const runState = await orchestrator.approve(plan);
    await orchestrator.execute(runState.id);

    const mergeCall = gitOps.calls.find((c) => c.method === "mergePR");
    expect(mergeCall).toBeDefined();
  });
});

describe("Orchestrator — conflict reporting", () => {
  it("captures the merge error message and shows the PR URL for conflicted tasks", async () => {
    const ticket = makeTicket();
    const ticketSource = new FakeTicketSource([ticket]);
    const adapter = new FakeAdapter();
    const gitOps = new FakeGitOperations();
    gitOps.mergeShouldFail = true;
    gitOps.mergeErrorMessage = "Pull Request has merge conflicts (mergePullRequest)";

    // mergeGate enabled + user approves → merge fails → conflicted
    const orchestrator = new Orchestrator(
      makeConfig({ mergeGate: true }), ticketSource, gitOps, [adapter], ":memory:",
      { mergeGatePrompt: async () => true },
    );

    const tickets = await orchestrator.intake();
    const plan = await orchestrator.plan(tickets);
    const runState = await orchestrator.approve(plan);
    const finalState = await orchestrator.execute(runState.id);

    const task = finalState.tasks.find((t) => t.id === "TICKET-001");
    expect(task!.status).toBe("conflicted");
    expect(task!.conflictReason).toBe("Pull Request has merge conflicts (mergePullRequest)");
    expect(task!.prUrl).toBe("https://github.com/owner/repo/pull/1");
  });
});

describe("Orchestrator — execution progress logging", () => {
  it("emits progress events for wave start, task start, task completion, and wave end", async () => {
    const ticket = makeTicket();
    const ticketSource = new FakeTicketSource([ticket]);
    const adapter = new FakeAdapter();
    const gitOps = new FakeGitOperations();

    const events: string[] = [];
    const orchestrator = new Orchestrator(
      makeConfig(), ticketSource, gitOps, [adapter], ":memory:",
      { onProgress: (msg) => events.push(msg) },
    );

    const tickets = await orchestrator.intake();
    const plan = await orchestrator.plan(tickets);
    const runState = await orchestrator.approve(plan);
    await orchestrator.execute(runState.id);

    // Should have events for wave start, task start, task completion, PR creation
    expect(events.some((e) => e.includes("Wave 0"))).toBe(true);
    expect(events.some((e) => e.includes("TICKET-001") && e.includes("starting"))).toBe(true);
    expect(events.some((e) => e.includes("TICKET-001") && e.includes("completed"))).toBe(true);
    expect(events.some((e) => e.includes("PR"))).toBe(true);
  });
});

describe("Orchestrator — user-driven execution model", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "orch-state-"));
  });
  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("persists run state to disk so a new Orchestrator instance can load it", async () => {
    const ticket = makeTicket();
    const ticketSource = new FakeTicketSource([ticket]);
    const adapter = new FakeAdapter();
    const gitOps = new FakeGitOperations();
    const statePath = join(stateDir, "state.json");

    // First instance: plan and approve
    const orch1 = new Orchestrator(
      makeConfig({ mergeGate: false }), ticketSource, gitOps, [adapter], statePath,
    );
    const tickets = await orch1.intake();
    const plan = await orch1.plan(tickets);
    const runState = await orch1.approve(plan);
    const runId = runState.id;

    // Second instance: load the same state file and verify the run exists
    const orch2 = new Orchestrator(
      makeConfig({ mergeGate: false }), ticketSource, gitOps, [adapter], statePath,
    );
    const loaded = orch2.getRunState(runId);
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(runId);
    expect(loaded!.tasks).toHaveLength(1);
    expect(loaded!.tasks[0].id).toBe("TICKET-001");
  });

  it("executeWave runs only the specified wave without auto-advancing", async () => {
    // Two independent tickets (wave 0) + one dependent on both (wave 1)
    const tickets = [
      makeTicket({ id: "T1", title: "Task one" }),
      makeTicket({ id: "T2", title: "Task two" }),
      makeTicket({ id: "T3", title: "Task three", dependencies: ["T1", "T2"] }),
    ];
    const ticketSource = new FakeTicketSource(tickets);
    const adapter = new FakeAdapter();
    const gitOps = new FakeGitOperations();
    const statePath = join(stateDir, "state.json");

    const orch = new Orchestrator(
      makeConfig({ mergeGate: false }), ticketSource, gitOps, [adapter], statePath,
    );
    const fetched = await orch.intake();
    const plan = await orch.plan(fetched);
    expect(plan.waves).toHaveLength(2);

    const runState = await orch.approve(plan);

    // Execute only wave 0
    const stateAfterWave0 = await orch.executeWave(runState.id, 0);
    expect(stateAfterWave0.currentWave).toBe(0); // didn't auto-advance

    // Wave 0 tasks completed, wave 1 task still pending
    const w0Tasks = stateAfterWave0.tasks.filter((t) => t.wave === 0);
    const w1Tasks = stateAfterWave0.tasks.filter((t) => t.wave === 1);
    expect(w0Tasks.every((t) => t.status === "completed")).toBe(true);
    expect(w1Tasks.every((t) => t.status === "pending")).toBe(true);

    // No merge should have happened (executeWave doesn't merge)
    const mergeCall = gitOps.calls.find((c) => c.method === "mergePR");
    expect(mergeCall).toBeUndefined();
  });

  it("mergeWave merges completed PRs from a specific wave", async () => {
    const ticket = makeTicket();
    const ticketSource = new FakeTicketSource([ticket]);
    const adapter = new FakeAdapter();
    const gitOps = new FakeGitOperations();
    const statePath = join(stateDir, "state.json");

    // mergeGate enabled with auto-approve so mergeWave actually merges
    const orch = new Orchestrator(
      makeConfig({ mergeGate: true }), ticketSource, gitOps, [adapter], statePath,
      { mergeGatePrompt: async () => true },
    );
    const tickets = await orch.intake();
    const plan = await orch.plan(tickets);
    const runState = await orch.approve(plan);

    // Execute wave 0 (creates PR but doesn't merge)
    await orch.executeWave(runState.id, 0);
    expect(gitOps.calls.find((c) => c.method === "mergePR")).toBeUndefined();

    // Now merge wave 0
    await orch.mergeWave(runState.id, 0);
    expect(gitOps.calls.find((c) => c.method === "mergePR")).toBeDefined();
  });

  it("limits concurrent sessions to maxParallelism", async () => {
    // 4 independent tasks in wave 0
    const tickets = [
      makeTicket({ id: "T1", title: "Task one" }),
      makeTicket({ id: "T2", title: "Task two" }),
      makeTicket({ id: "T3", title: "Task three" }),
      makeTicket({ id: "T4", title: "Task four" }),
    ];
    const ticketSource = new FakeTicketSource(tickets);
    const adapter = new ConcurrencyTrackingAdapter();
    const gitOps = new FakeGitOperations();
    const statePath = join(stateDir, "state.json");

    const orch = new Orchestrator(
      makeConfig({ mergeGate: false }), ticketSource, gitOps, [adapter], statePath,
    );
    const fetched = await orch.intake();
    const plan = await orch.plan(fetched);
    const runState = await orch.approve(plan);

    // Execute wave 0 with maxParallelism=2
    await orch.executeWave(runState.id, 0, { maxParallelism: 2 });

    // At no point should more than 2 sessions have been active simultaneously
    expect(adapter.maxConcurrent).toBeLessThanOrEqual(2);
    expect(adapter.maxConcurrent).toBe(2);
  });

  it("executeWave with taskIds runs only the specified tasks", async () => {
    // 3 independent tasks in wave 0
    const tickets = [
      makeTicket({ id: "T1", title: "Task one" }),
      makeTicket({ id: "T2", title: "Task two" }),
      makeTicket({ id: "T3", title: "Task three" }),
    ];
    const ticketSource = new FakeTicketSource(tickets);
    const adapter = new FakeAdapter();
    const gitOps = new FakeGitOperations();
    const statePath = join(stateDir, "state.json");

    const orch = new Orchestrator(
      makeConfig({ mergeGate: false }), ticketSource, gitOps, [adapter], statePath,
    );
    const fetched = await orch.intake();
    const plan = await orch.plan(fetched);
    const runState = await orch.approve(plan);

    // Execute only T1 and T3 from wave 0
    const state = await orch.executeWave(runState.id, 0, { taskIds: ["T1", "T3"] });

    const t1 = state.tasks.find((t) => t.id === "T1");
    const t2 = state.tasks.find((t) => t.id === "T2");
    const t3 = state.tasks.find((t) => t.id === "T3");
    expect(t1!.status).toBe("completed");
    expect(t3!.status).toBe("completed");
    expect(t2!.status).toBe("pending"); // not selected, still pending
  });

  it("executeWave skips tasks that are already completed", async () => {
    const tickets = [
      makeTicket({ id: "T1", title: "Task one" }),
      makeTicket({ id: "T2", title: "Task two" }),
    ];
    const ticketSource = new FakeTicketSource(tickets);
    const adapter = new FakeAdapter();
    const gitOps = new FakeGitOperations();
    const statePath = join(stateDir, "state.json");

    const orch = new Orchestrator(
      makeConfig({ mergeGate: false }), ticketSource, gitOps, [adapter], statePath,
    );
    const fetched = await orch.intake();
    const plan = await orch.plan(fetched);
    const runState = await orch.approve(plan);

    // Run only T1 first
    await orch.executeWave(runState.id, 0, { taskIds: ["T1"] });

    // Run the whole wave — T1 should be skipped, T2 should run
    const startSessionCount = gitOps.calls.filter((c) => c.method === "createWorktree").length;
    await orch.executeWave(runState.id, 0);
    const endSessionCount = gitOps.calls.filter((c) => c.method === "createWorktree").length;

    // Only one new worktree should have been created (for T2)
    expect(endSessionCount - startSessionCount).toBe(1);

    const state = orch.getRunState(runState.id);
    expect(state!.tasks.every((t) => t.status === "completed")).toBe(true);
  });

  it("listRuns returns all persisted runs", async () => {
    const ticketSource = new FakeTicketSource([makeTicket()]);
    const adapter = new FakeAdapter();
    const gitOps = new FakeGitOperations();
    const statePath = join(stateDir, "state.json");

    const orch = new Orchestrator(
      makeConfig({ mergeGate: false }), ticketSource, gitOps, [adapter], statePath,
    );
    const tickets = await orch.intake();
    const plan = await orch.plan(tickets);
    const runState1 = await orch.approve(plan);

    // Create a second run
    const tickets2 = await orch.intake();
    const plan2 = await orch.plan(tickets2);
    const runState2 = await orch.approve(plan2);

    // New instance loads from disk
    const orch2 = new Orchestrator(
      makeConfig({ mergeGate: false }), ticketSource, gitOps, [adapter], statePath,
    );
    const runs = orch2.listRuns();
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.some((r) => r.id === runState1.id)).toBe(true);
    expect(runs.some((r) => r.id === runState2.id)).toBe(true);
  });
});

/**
 * Adapter that tracks how many sessions are active concurrently.
 * Used to verify maxParallelism enforcement.
 */
class ConcurrencyTrackingAdapter implements Adapter {
  readonly name = "stub";
  private active = 0;
  maxConcurrent = 0;

  async startSession(_worktreePath: string, _prompt: string): Promise<string> {
    this.active++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    return `session-${Date.now()}-${Math.random()}`;
  }

  async waitForCompletion(_sessionId: string): Promise<AdapterResult> {
    // Simulate some work time so concurrency is observable
    await new Promise((resolve) => setTimeout(resolve, 20));
    this.active--;
    return {
      success: true,
      exitCode: 0,
      output: "ok",
      lastMessage: "done",
    };
  }

  async attach(_sessionId: string): Promise<InteractiveSession> {
    throw new Error("Not supported");
  }
}

/**
 * FakeGitOperations variant that detects concurrent createWorktree calls.
 * Git's worktree metadata is not safe under concurrent `git worktree add` —
 * if two calls overlap, this fake records the error.
 */
class SequentialDetectingGitOperations implements GitOperations {
  calls: RecordedCall[] = [];
  prUrl = "https://github.com/owner/repo/pull/1";
  prNumber = 1;
  concurrentWorktreeError?: string;
  private worktreeInProgress = false;

  async createWorktree(branchName: string, worktreePath: string, baseBranch: string): Promise<void> {
    this.calls.push({ method: "createWorktree", args: [branchName, worktreePath, baseBranch] });
    if (this.worktreeInProgress) {
      this.concurrentWorktreeError = `Concurrent createWorktree detected: ${branchName} started while another was in progress`;
    }
    this.worktreeInProgress = true;
    // Simulate the non-zero time git worktree add takes
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.worktreeInProgress = false;
  }

  async commitAll(worktreePath: string, message: string): Promise<void> {
    this.calls.push({ method: "commitAll", args: [worktreePath, message] });
  }

  async push(worktreePath: string, branchName: string): Promise<void> {
    this.calls.push({ method: "push", args: [worktreePath, branchName] });
  }

  async createPR(title: string, body: string, baseBranch: string, headBranch: string): Promise<{ url: string; number: number }> {
    this.calls.push({ method: "createPR", args: [title, body, baseBranch, headBranch] });
    return { url: this.prUrl, number: this.prNumber };
  }

  async mergePR(prUrl: string): Promise<void> {
    this.calls.push({ method: "mergePR", args: [prUrl] });
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    this.calls.push({ method: "removeWorktree", args: [worktreePath] });
  }
}
