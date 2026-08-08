import type { Adapter, AdapterResult, InteractiveSession } from "@orchestrator/types";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * DevinAdapter — bridges the orchestrator to the Devin CLI.
 *
 * Interfaces via CLI subprocess:
 * - start_session: `devin -p <prompt> --cd <worktree> --permission-mode auto-accept`
 * - wait_for_completion: waits for process exit, parses JSON output
 * - attach: `devin -r <session_id>` (interactive resume)
 *
 * Agents always run in automatic accept mode — no approval prompts.
 */
export class DevinAdapter implements Adapter {
  readonly name = "devin";

  private sessions = new Map<string, ChildProcess>();
  private outputs = new Map<string, string>();

  async startSession(worktreePath: string, prompt: string): Promise<string> {
    const sessionId = `devin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Write prompt to a temp file to avoid shell escaping issues
    const tempDir = await mkdtemp(join(tmpdir(), "orchestrator-devin-"));
    const promptFile = join(tempDir, "prompt.txt");
    await writeFile(promptFile, prompt, "utf-8");

    const child = spawn(
      "devin",
      [
        "-p",
        "--prompt-file", promptFile,
        "--cd", worktreePath,
        "--permission-mode", "auto-accept",
        "--respect-workspace-trust", "false",
      ],
      {
        cwd: worktreePath,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    this.sessions.set(sessionId, child);
    this.outputs.set(sessionId, "");

    child.stdout?.on("data", (chunk: Buffer) => {
      this.outputs.set(sessionId, (this.outputs.get(sessionId) ?? "") + chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.outputs.set(sessionId, (this.outputs.get(sessionId) ?? "") + chunk.toString());
    });

    return sessionId;
  }

  async waitForCompletion(sessionId: string): Promise<AdapterResult> {
    const child = this.sessions.get(sessionId);
    if (!child) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return new Promise<AdapterResult>((resolve) => {
      child.on("exit", (code: number | null) => {
        const output = this.outputs.get(sessionId) ?? "";
        const exitCode = code ?? 1;
        const lastMessage = this.extractLastMessage(output);

        resolve({
          success: exitCode === 0,
          exitCode,
          output,
          lastMessage,
        });

        this.sessions.delete(sessionId);
        this.outputs.delete(sessionId);
      });
    });
  }

  async attach(_sessionId: string): Promise<InteractiveSession> {
    // Devin resume: `devin -r <session_id>` — interactive mode
    // TODO: implement interactive session with stdin/stdout piping
    throw new Error("Attach not yet implemented for Devin adapter");
  }

  /**
   * Extract the agent's final message from the output.
   * TODO: parse Devin's JSON output format for the last message.
   */
  private extractLastMessage(output: string): string {
    // Placeholder — will parse Devin's structured output
    const lines = output.trim().split("\n");
    return lines[lines.length - 1] ?? "";
  }
}
