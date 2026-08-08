import type { Adapter, AdapterResult, InteractiveSession } from "@orchestrator/types";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * CodexAdapter — bridges the orchestrator to the Codex CLI.
 *
 * Interfaces via CLI subprocess:
 * - start_session: `codex exec <prompt> -C <worktree> --json --dangerously-bypass-approvals-and-sandbox`
 * - wait_for_completion: waits for process exit, parses JSONL output
 * - attach: `codex exec resume <session_id>` (interactive resume)
 *
 * Agents always run in automatic accept mode — no approval prompts.
 * Uses --json for structured JSONL event output and -o for the last message file.
 */
export class CodexAdapter implements Adapter {
  readonly name = "codex";

  private sessions = new Map<string, ChildProcess>();
  private outputs = new Map<string, string>();
  private lastMessageFiles = new Map<string, string>();

  async startSession(worktreePath: string, prompt: string): Promise<string> {
    const sessionId = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Create a temp file for the last message output
    const tempDir = await mkdtemp(join(tmpdir(), "orchestrator-codex-"));
    const lastMessageFile = join(tempDir, "last-message.txt");
    this.lastMessageFiles.set(sessionId, lastMessageFile);

    const child = spawn(
      "codex",
      [
        "exec",
        prompt,
        "-C", worktreePath,
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "-o", lastMessageFile,
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
      child.on("exit", async (code: number | null) => {
        const output = this.outputs.get(sessionId) ?? "";
        const exitCode = code ?? 1;

        // Read the last message from the output file
        let lastMessage = "";
        const lastMessageFile = this.lastMessageFiles.get(sessionId);
        if (lastMessageFile) {
          try {
            lastMessage = await readFile(lastMessageFile, "utf-8");
          } catch {
            lastMessage = this.extractLastMessage(output);
          }
        }

        resolve({
          success: exitCode === 0,
          exitCode,
          output,
          lastMessage: lastMessage.trim(),
        });

        this.sessions.delete(sessionId);
        this.outputs.delete(sessionId);
        this.lastMessageFiles.delete(sessionId);
      });
    });
  }

  async attach(_sessionId: string): Promise<InteractiveSession> {
    // Codex resume: `codex exec resume <session_id> <prompt>` — interactive mode
    // TODO: implement interactive session with stdin/stdout piping
    throw new Error("Attach not yet implemented for Codex adapter");
  }

  /**
   * Fallback: extract the last message from JSONL output.
   * Codex --json outputs events as JSONL. The last message event
   * contains the agent's final response.
   */
  private extractLastMessage(output: string): string {
    const lines = output.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]);
        if (event.type === "message" && event.content) {
          return event.content;
        }
      } catch {
        continue;
      }
    }
    return lines[lines.length - 1] ?? "";
  }
}
