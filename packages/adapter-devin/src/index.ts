import type { Adapter, AdapterResult, InteractiveSession } from "@orchestrator/types";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * Options for constructing a DevinAdapter.
 */
export interface DevinAdapterOptions {
  /**
   * Path to the `devin` binary. Defaults to `"devin"` (resolved from PATH).
   * Tests inject a fake CLI path here so no real Devin CLI is spawned.
   */
  binary?: string;
  /**
   * AI model for the Devin session (passed as `--model <model>`).
   * When omitted, Devin uses its default model.
   */
  model?: string;
}

interface SessionState {
  child: ChildProcess;
  /** Resolves with the process exit code once the child exits. */
  exitPromise: Promise<number>;
  /** Combined stdout + stderr, preserved for diagnostics on failure. */
  output: string;
  /** Stdout only — in --print mode this is the agent's final response. */
  stdout: string;
  /** Absolute path of the worktree the session runs in. */
  worktreePath: string;
  /** Devin's native session ID, captured via `devin list` after completion. */
  devinSessionId?: string;
}

interface DevinSessionListing {
  id: string;
  working_directory: string;
  /** Unix timestamp of the session's last activity (most recent first). */
  last_activity_at?: number;
}

/**
 * DevinAdapter — bridges the orchestrator to the Devin CLI.
 *
 * Interfaces via CLI subprocess:
 * - startSession: `devin -p --prompt-file <file> --permission-mode bypass
 *   --respect-workspace-trust false` with the subprocess cwd set to the worktree
 * - waitForCompletion: waits for process exit, parses stdout for the lastMessage,
 *   then captures Devin's native session ID via `devin list --format json`
 * - attach: `devin -r <session_id>` (interactive resume)
 *
 * Agents always run in automatic accept mode — `--permission-mode bypass`
 * auto-approves every tool call so the agent never blocks waiting for approval.
 * The worktree is set via the subprocess `cwd` (the Devin CLI has no `--cd` flag).
 */
export class DevinAdapter implements Adapter {
  readonly name = "devin";

  private readonly binary: string;
  readonly model?: string;
  private sessions = new Map<string, SessionState>();
  /** Maps orchestrator session IDs to Devin native session IDs. Persists across
   * waitForCompletion so attach can resume after a session completes. */
  private devinSessionIds = new Map<string, string>();

  constructor(options: DevinAdapterOptions = {}) {
    this.binary = options.binary ?? "devin";
    this.model = options.model;
  }

  async startSession(worktreePath: string, prompt: string): Promise<string> {
    const sessionId = `devin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Resolve to an absolute path so the subprocess cwd is unambiguous.
    const absWorktree = resolve(worktreePath);

    // Write the prompt to a temp file to avoid shell escaping issues.
    const tempDir = await mkdtemp(join(tmpdir(), "orchestrator-devin-"));
    const promptFile = join(tempDir, "prompt.txt");
    await writeFile(promptFile, prompt, "utf-8");

    const child = spawn(
      this.binary,
      [
        "-p",
        "--prompt-file", promptFile,
        "--permission-mode", "bypass",
        "--respect-workspace-trust", "false",
        ...(this.model ? ["--model", this.model] : []),
      ],
      {
        cwd: absWorktree,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    // Capture the exit promise up front so waitForCompletion is robust even if
    // the process exits before waitForCompletion attaches its listener.
    const exitPromise = new Promise<number>((resolveExit) => {
      child.on("exit", (code: number | null) => resolveExit(code ?? 1));
    });

    const session: SessionState = {
      child,
      exitPromise,
      output: "",
      stdout: "",
      worktreePath: absWorktree,
    };
    this.sessions.set(sessionId, session);

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      session.stdout += text;
      session.output += text;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      session.output += chunk.toString();
    });

    // Close stdin so Devin doesn't block waiting for stdin input in print mode.
    child.stdin?.end();

    return sessionId;
  }

  async waitForCompletion(sessionId: string): Promise<AdapterResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const exitCode = await session.exitPromise;

    // In --print mode, stdout is the agent's final response.
    const lastMessage = this.extractLastMessage(session.stdout);

    // Capture Devin's native session ID via `devin list --format json`, filtered
    // to the session whose working directory matches this worktree. Used so
    // attach can resume via `devin -r <session_id>`.
    const devinSessionId = await this.captureSessionId(session.worktreePath);
    if (devinSessionId) {
      session.devinSessionId = devinSessionId;
      this.devinSessionIds.set(sessionId, devinSessionId);
    }

    this.sessions.delete(sessionId);

    return {
      success: exitCode === 0,
      exitCode,
      output: session.output,
      lastMessage,
    };
  }

  async attach(sessionId: string): Promise<InteractiveSession> {
    // Resume using Devin's native session ID if captured via `devin list`;
    // fall back to the orchestrator-generated ID for backward compatibility.
    const resumeId = this.devinSessionIds.get(sessionId) ?? sessionId;
    const child = spawn(
      this.binary,
      ["-r", resumeId],
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
   * Capture Devin's native session ID by listing sessions for the worktree.
   * `devin list --format json` is already scoped to the current directory (the
   * subprocess cwd is the worktree), so the returned sessions all belong to this
   * worktree. We pick the most recently active one — worktrees are 1:1 with
   * tasks, so the session that just ran is the most recent.
   *
   * We do NOT compare working_directory strings because macOS symlinks (/var →
   * /private/var) make the subprocess's process.cwd() disagree with the path the
   * orchestrator holds, even when they refer to the same directory.
   *
   * Returns undefined if the lookup fails or no session is found, so attach
   * falls back to the orchestrator-generated ID.
   */
  private async captureSessionId(worktreePath: string): Promise<string | undefined> {
    try {
      const result = await this.runDevinList(worktreePath);
      const sessions = JSON.parse(result) as DevinSessionListing[];
      if (sessions.length === 0) return undefined;
      // Pick the most recently active session — worktrees are 1:1 with tasks,
      // so the session that just ran is the most recent. Sessions without a
      // last_activity_at sort as oldest.
      const mostRecent = [...sessions].sort(
        (a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0),
      )[0];
      return mostRecent.id;
    } catch {
      return undefined;
    }
  }

  /**
   * Run `devin list --format json` in the worktree and return its stdout.
   */
  private runDevinList(worktreePath: string): Promise<string> {
    return new Promise<string>((resolveRun, rejectRun) => {
      const child = spawn(
        this.binary,
        ["list", "--format", "json"],
        {
          cwd: worktreePath,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", rejectRun);
      child.on("exit", (code) => {
        if (code === 0) resolveRun(stdout);
        else rejectRun(new Error(`devin list exited ${code}: ${stderr}`));
      });
      child.stdin?.end();
    });
  }

  /**
   * Extract the agent's final message from stdout.
   * In --print mode, stdout is the agent's final response. We trim trailing
   * whitespace and fall back to the last non-empty line if there is noise.
   */
  private extractLastMessage(stdout: string): string {
    const trimmed = stdout.trim();
    if (trimmed) return trimmed;
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines[lines.length - 1] ?? "";
  }
}
