import type { Adapter, AdapterResult, InteractiveSession } from "@orchestrator/types";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * Options for constructing a CodexAdapter.
 */
export interface CodexAdapterOptions {
  /**
   * Path to the `codex` binary. Defaults to `"codex"` (resolved from PATH).
   * Tests inject a fake CLI path here so no real Codex CLI is spawned.
   */
  binary?: string;
  /**
   * AI model for the Codex session (passed as `-m <model>`).
   * When omitted, Codex uses its default model.
   */
  model?: string;
}

interface SessionState {
  child: ChildProcess;
  /** Resolves with the process exit code once the child exits. */
  exitPromise: Promise<number>;
  output: string;
  lastMessageFile: string;
  /** Codex's native session ID, captured from JSONL output if present. */
  codexSessionId?: string;
}

/**
 * CodexAdapter — bridges the orchestrator to the Codex CLI.
 *
 * Interfaces via CLI subprocess:
 * - startSession: `codex exec <prompt> -C <worktree> --json --dangerously-bypass-approvals-and-sandbox -o <last-message-file>`
 * - waitForCompletion: waits for process exit, reads the last-message file, parses JSONL output
 * - attach: `codex exec resume <session_id>` (interactive resume)
 *
 * Agents always run in automatic accept mode — no approval prompts.
 * Uses --json for structured JSONL event output and -o for the last message file.
 */
export class CodexAdapter implements Adapter {
  readonly name = "codex";

  private readonly binary: string;
  private readonly model?: string;
  private sessions = new Map<string, SessionState>();
  /** Maps orchestrator session IDs to Codex native session IDs. Persists across
   * waitForCompletion so attach can resume after a session completes. */
  private codexSessionIds = new Map<string, string>();

  constructor(options: CodexAdapterOptions = {}) {
    this.binary = options.binary ?? "codex";
    this.model = options.model;
  }

  async startSession(worktreePath: string, prompt: string): Promise<string> {
    const sessionId = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Resolve to an absolute path so codex's -C flag isn't misinterpreted
    // relative to its own cwd (which is also set to the worktree).
    const absWorktree = resolve(worktreePath);

    // Create a temp file for the last message output
    const tempDir = await mkdtemp(join(tmpdir(), "orchestrator-codex-"));
    const lastMessageFile = join(tempDir, "last-message.txt");

    const child = spawn(
      this.binary,
      [
        "exec",
        prompt,
        "-C", absWorktree,
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "-o", lastMessageFile,
        ...(this.model ? ["-m", this.model] : []),
      ],
      {
        cwd: absWorktree,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    // Capture the exit promise up front so waitForCompletion is robust even if
    // the process exits before waitForCompletion attaches its listener.
    const exitPromise = new Promise<number>((resolve) => {
      child.on("exit", (code: number | null) => resolve(code ?? 1));
    });

    const session: SessionState = { child, exitPromise, output: "", lastMessageFile };
    this.sessions.set(sessionId, session);

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      session.output += text;
      this.captureSessionId(session, text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      session.output += chunk.toString();
    });

    // Close stdin so Codex doesn't block waiting for stdin input. The prompt is
    // passed as a positional argument; Codex only reads stdin when it's an open
    // pipe, and an open pipe makes it hang on "Reading additional input from stdin...".
    child.stdin?.end();

    return sessionId;
  }

  async waitForCompletion(sessionId: string): Promise<AdapterResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const exitCode = await session.exitPromise;

    // Read the last message from the -o output file; fall back to JSONL parsing.
    let lastMessage = "";
    try {
      lastMessage = await readFile(session.lastMessageFile, "utf-8");
    } catch {
      lastMessage = this.extractLastMessage(session.output);
    }

    const result: AdapterResult = {
      success: exitCode === 0,
      exitCode,
      output: session.output,
      lastMessage: lastMessage.trim(),
    };

    // Persist the Codex native session ID so attach can resume after completion.
    if (session.codexSessionId) {
      this.codexSessionIds.set(sessionId, session.codexSessionId);
    }

    this.sessions.delete(sessionId);
    return result;
  }

  async attach(sessionId: string): Promise<InteractiveSession> {
    // Resume using Codex's native session ID if captured from JSONL output;
    // fall back to the orchestrator-generated ID for backward compatibility.
    const resumeId = this.codexSessionIds.get(sessionId) ?? sessionId;
    const child = spawn(
      this.binary,
      ["exec", "resume", resumeId],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const outputCallbacks = new Set<(chunk: string) => void>();
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const cb of outputCallbacks) cb(chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const cb of outputCallbacks) cb(chunk.toString());
    });

    return {
      async send(message: string): Promise<void> {
        child.stdin?.write(message + "\n");
      },
      onOutput(callback: (chunk: string) => void): void {
        outputCallbacks.add(callback);
      },
      async detach(): Promise<boolean> {
        child.stdin?.end();
        child.kill();
        // Whether the issue was resolved is determined by the orchestrator
        // (it asks the user on detach); the adapter only tears down the pipe.
        return false;
      },
    };
  }

  /**
   * Scan a stdout chunk for a JSONL session event and capture the native
   * Codex session ID. Codex emits a session event early in its JSONL output
   * with the session ID needed for `codex exec resume`.
   */
  private captureSessionId(session: SessionState, chunk: string): void {
    if (session.codexSessionId) return; // already captured
    for (const line of chunk.split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.type === "session" && event.session_id) {
          session.codexSessionId = event.session_id;
          return;
        }
      } catch {
        continue;
      }
    }
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
