import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { CodexAdapter } from "./index.js";

/**
 * Seam 2: Adapter contract — subprocess spawning tests.
 *
 * The CodexAdapter is tested against a fixture-based fake CLI binary that
 * mimics Codex's interface: it accepts the expected flags, writes a last-message
 * file (-o), emits JSONL on stdout, and exits with a configurable code.
 *
 * The fake CLI reads its behaviour from environment variables so a single
 * fixture covers success, failure, and last-message scenarios.
 */
describe("CodexAdapter", () => {
  let worktree: string;
  let fakeCli: string;
  let argvFile: string;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), "orchestrator-codex-wt-"));
    const fixtureDir = await mkdtemp(join(tmpdir(), "orchestrator-codex-fake-"));
    fakeCli = join(fixtureDir, "fake-codex.mjs");
    argvFile = join(fixtureDir, "argv.json");
    await writeFakeCli(fakeCli, argvFile);
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
    delete process.env.FAKE_CODEX_EXIT;
    delete process.env.FAKE_CODEX_LAST_MESSAGE;
    delete process.env.FAKE_CODEX_JSONL;
    delete process.env.FAKE_CODEX_SKIP_LAST_MESSAGE;
    delete process.env.FAKE_CODEX_SESSION_ID;
  });

  it("spawns codex exec with automatic-accept, worktree, --json, and -o flags", async () => {
    const adapter = new CodexAdapter({ binary: fakeCli });
    const sessionId = await adapter.startSession(worktree, "Implement the thing");
    await adapter.waitForCompletion(sessionId);

    const args = JSON.parse(await readFile(argvFile, "utf-8")) as string[];

    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("Implement the thing");
    expect(args).toContain("--json");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain("-C");
    expect(args[args.indexOf("-C") + 1]).toBe(worktree);
    expect(args).toContain("-o");
    // -o points at a last-message file path
    expect(typeof args[args.indexOf("-o") + 1]).toBe("string");
    expect(args[args.indexOf("-o") + 1].length).toBeGreaterThan(0);
  });

  it("passes an absolute worktree path to -C even when given a relative path", async () => {
    // The wave executor uses relative worktree paths (e.g. .orchestrator/worktrees/TASK-1).
    // Codex resolves -C relative to its own cwd, so a relative -C would point to a
    // nonexistent nested path. The adapter must resolve to absolute.
    const adapter = new CodexAdapter({ binary: fakeCli });
    const sessionId = await adapter.startSession(worktree, "do work");
    await adapter.waitForCompletion(sessionId);

    const args = JSON.parse(await readFile(argvFile, "utf-8")) as string[];
    const cPath = args[args.indexOf("-C") + 1];
    expect(isAbsolute(cPath)).toBe(true);
    expect(cPath).toBe(resolve(worktree));
  });

  it("reports success when the process exits with code 0", async () => {
    const adapter = new CodexAdapter({ binary: fakeCli });
    const sessionId = await adapter.startSession(worktree, "do work");
    const result = await adapter.waitForCompletion(sessionId);

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("reports failure and includes output when the process exits non-zero", async () => {
    process.env.FAKE_CODEX_EXIT = "1";
    process.env.FAKE_CODEX_JSONL = JSON.stringify({ type: "error", content: "boom" });
    const adapter = new CodexAdapter({ binary: fakeCli });
    const sessionId = await adapter.startSession(worktree, "do work");
    const result = await adapter.waitForCompletion(sessionId);

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    // Full output is preserved for diagnostics on failure
    expect(result.output).toContain("boom");
  });

  it("reads the lastMessage from the -o last-message file", async () => {
    process.env.FAKE_CODEX_LAST_MESSAGE = "Implemented the codex adapter with tests.";
    const adapter = new CodexAdapter({ binary: fakeCli });
    const sessionId = await adapter.startSession(worktree, "do work");
    const result = await adapter.waitForCompletion(sessionId);

    expect(result.lastMessage).toBe("Implemented the codex adapter with tests.");
  });

  it("falls back to the last JSONL message event when the -o file is unavailable", async () => {
    // Simulate Codex not writing the -o file: emit JSONL message events instead.
    process.env.FAKE_CODEX_SKIP_LAST_MESSAGE = "1";
    process.env.FAKE_CODEX_JSONL = [
      JSON.stringify({ type: "message", content: "first message" }),
      JSON.stringify({ type: "message", content: "final summary from jsonl" }),
    ].join("\n");
    const adapter = new CodexAdapter({ binary: fakeCli });
    const sessionId = await adapter.startSession(worktree, "do work");
    const result = await adapter.waitForCompletion(sessionId);

    expect(result.lastMessage).toBe("final summary from jsonl");
  });

  it("attach resumes via codex exec resume <session_id> and streams output", async () => {
    const adapter = new CodexAdapter({ binary: fakeCli });
    const session = await adapter.attach("sess-123");

    let output = "";
    session.onOutput((chunk) => {
      output += chunk;
    });

    // Wait for the resume banner, then send a message the fake echoes back.
    await waitForSubstring(() => output, "resumed session sess-123");
    await session.send("please fix the bug");
    await waitForSubstring(() => output, "echo: please fix the bug");

    // Verify the resume command was spawned with the session id
    const args = JSON.parse(await readFile(argvFile, "utf-8")) as string[];
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args[2]).toBe("sess-123");

    await session.detach();
  });

  it("uses Codex native session ID from JSONL output for attach resume", async () => {
    // The fake CLI emits a session event with a native session ID in JSONL.
    process.env.FAKE_CODEX_SESSION_ID = "codex-native-sess-abc";
    const adapter = new CodexAdapter({ binary: fakeCli });
    const orchestratorId = await adapter.startSession(worktree, "do work");
    await adapter.waitForCompletion(orchestratorId);

    // attach receives the orchestrator-generated ID but should resume using
    // Codex's native session ID captured from the JSONL output.
    const session = await adapter.attach(orchestratorId);
    let output = "";
    session.onOutput((chunk) => {
      output += chunk;
    });
    // Wait for the resume banner so the process has recorded its argv.
    await waitForSubstring(() => output, "resumed session");
    await session.detach();

    const args = JSON.parse(await readFile(argvFile, "utf-8")) as string[];
    expect(args[1]).toBe("resume");
    expect(args[2]).toBe("codex-native-sess-abc");
  });
});

/**
 * Poll until the current value contains the expected substring.
 * Used to wait for streaming subprocess output without flaky sleeps.
 */
function waitForSubstring(
  getCurrent: () => string,
  substring: string,
  timeoutMs = 2000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (getCurrent().includes(substring)) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timed out waiting for "${substring}". Got: ${getCurrent()}`));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/**
 * Write a fake `codex` CLI script that records its argv and behaves per env vars:
 * - FAKE_CODEX_EXIT (default "0"): process exit code
 * - FAKE_CODEX_LAST_MESSAGE (default "done"): content written to the -o file
 * - FAKE_CODEX_JSONL (default ""): JSONL lines written to stdout before exit
 */
async function writeFakeCli(path: string, argvFile: string): Promise<void> {
  const script = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv;
const args = argv.slice(2);
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));

// Interactive resume mode: \`codex exec resume <session_id>\`
// Stays alive, streams a banner, and echoes stdin lines back on stdout.
if (args[0] === "exec" && args[1] === "resume") {
  const sessionId = args[2] ?? "";
  process.stdout.write("resumed session " + sessionId + "\\n");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    process.stdout.write("echo: " + line + "\\n");
  });
  rl.on("close", () => process.exit(0));
  // Keep alive until stdin closes or the process is killed (event loop waits).
} else {
  // Normal exec mode: parse -o <last-message-file> from argv
  let lastMessageFile = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-o" && i + 1 < argv.length) lastMessageFile = argv[i + 1];
  }

  // Emit a session event with a native session ID if configured.
  const nativeSessionId = process.env.FAKE_CODEX_SESSION_ID;
  if (nativeSessionId) {
    process.stdout.write(JSON.stringify({ type: "session", session_id: nativeSessionId }) + "\\n");
  }

  const jsonl = process.env.FAKE_CODEX_JSONL ?? "";
  if (jsonl) {
    for (const line of jsonl.split("\\n")) {
      process.stdout.write(line + "\\n");
    }
  }

  if (lastMessageFile && !process.env.FAKE_CODEX_SKIP_LAST_MESSAGE) {
    writeFileSync(lastMessageFile, process.env.FAKE_CODEX_LAST_MESSAGE ?? "done");
  }

  // Mimic real Codex: when stdin is a pipe, wait for EOF before exiting.
  // This catches adapters that leave stdin open (which blocks the real CLI).
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.exit(Number(process.env.FAKE_CODEX_EXIT ?? "0"));
  });
}
`;
  await writeFile(path, script, "utf-8");
  await chmod(path, 0o755);
}
