import { describe, it, expect } from "vitest";
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
    if (this.mergeShouldFail) throw new Error("Merge conflict");
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
    const config = makeConfig();
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

    // Assert — the PR was merged (auto-merge, no merge gate)
    const mergeCall = gitOps.calls.find((c) => c.method === "mergePR");
    expect(mergeCall).toBeDefined();

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
    const orchestrator = new Orchestrator(makeConfig(), ticketSource, gitOps, [failingAdapter], ":memory:");

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
