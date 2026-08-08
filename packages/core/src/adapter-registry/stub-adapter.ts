import type { Adapter, AdapterResult, InteractiveSession } from "@orchestrator/types";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * StubAdapter — a no-op adapter for testing and the tracer bullet.
 * Writes a small marker file to the worktree so there's something to commit.
 * Returns success with a fake lastMessage. Does not spawn any real process.
 */
export class StubAdapter implements Adapter {
  readonly name = "stub";

  async startSession(worktreePath: string, _prompt: string): Promise<string> {
    // Write a marker file so git has something to commit in real usage
    await mkdir(worktreePath, { recursive: true });
    await writeFile(
      join(worktreePath, "STUB_ADAPTER_OUTPUT.md"),
      "# Stub Adapter Output\n\nThis file was created by the stub adapter for testing purposes.\n",
    );
    return `stub-session-${Date.now()}`;
  }

  async waitForCompletion(_sessionId: string): Promise<AdapterResult> {
    return {
      success: true,
      exitCode: 0,
      output: "Stub adapter completed successfully",
      lastMessage: "Stub adapter: task completed with no real changes.",
    };
  }

  async attach(_sessionId: string): Promise<InteractiveSession> {
    throw new Error("Attach not supported by StubAdapter");
  }
}
