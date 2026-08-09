import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DevinAdapter } from "./index.js";

/**
 * Seam 2: Adapter contract — subprocess spawning tests.
 *
 * The DevinAdapter is tested against a fixture-based fake CLI binary that
 * mimics the Devin CLI's interface: it accepts the expected flags, prints a
 * response in --print mode, emits a session list for `devin list --format json`,
 * and provides an interactive resume mode for `devin -r <session_id>`.
 *
 * The fake CLI reads its behaviour from environment variables so a single
 * fixture covers success, failure, response, and session-id scenarios.
 */
describe("DevinAdapter", () => {
  let worktree: string;
  let fakeCli: string;
  let argvPrint: string;
  let argvList: string;
  let argvResume: string;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), "orchestrator-devin-wt-"));
    const fixtureDir = await mkdtemp(join(tmpdir(), "orchestrator-devin-fake-"));
    fakeCli = join(fixtureDir, "fake-devin.mjs");
    argvPrint = join(fixtureDir, "argv-print.json");
    argvList = join(fixtureDir, "argv-list.json");
    argvResume = join(fixtureDir, "argv-resume.json");
    await writeFakeCli(fakeCli, { argvPrint, argvList, argvResume });
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
    delete process.env.FAKE_DEVIN_EXIT;
    delete process.env.FAKE_DEVIN_RESPONSE;
    delete process.env.FAKE_DEVIN_SESSION_ID;
    delete process.env.FAKE_DEVIN_SKIP_LIST;
  });

  it("spawns devin -p with prompt-file, bypass, and respect-workspace-trust flags", async () => {
    const adapter = new DevinAdapter({ binary: fakeCli });
    const sessionId = await adapter.startSession(worktree, "Implement the thing");
    await adapter.waitForCompletion(sessionId);

    const args = JSON.parse(await readFile(argvPrint, "utf-8")) as string[];

    expect(args).toContain("-p");
    expect(args).toContain("--prompt-file");
    // --prompt-file points at a real file path
    expect(typeof args[args.indexOf("--prompt-file") + 1]).toBe("string");
    expect(args[args.indexOf("--prompt-file") + 1].length).toBeGreaterThan(0);
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypass");
    expect(args).toContain("--respect-workspace-trust");
    expect(args[args.indexOf("--respect-workspace-trust") + 1]).toBe("false");
    // The worktree is set via the subprocess cwd, not via a (nonexistent) --cd flag
    expect(args).not.toContain("--cd");
  });

  it("writes the prompt to the --prompt-file temp file", async () => {
    const adapter = new DevinAdapter({ binary: fakeCli });
    const sessionId = await adapter.startSession(worktree, "Implement the devin adapter");
    await adapter.waitForCompletion(sessionId);

    const args = JSON.parse(await readFile(argvPrint, "utf-8")) as string[];
    const promptFile = args[args.indexOf("--prompt-file") + 1];
    const contents = await readFile(promptFile, "utf-8");
    expect(contents).toBe("Implement the devin adapter");
  });

  it("runs devin list in the worktree to capture the native session ID", async () => {
    // The wave executor uses relative worktree paths; the adapter must resolve to
    // absolute so the subprocess cwd is unambiguous. The fake `devin list`
    // records process.cwd() as the session working_directory, and the adapter
    // only matches when that equals the worktree — proving the cwd was set.
    process.env.FAKE_DEVIN_SESSION_ID = "devin-cwd-sess";
    const adapter = new DevinAdapter({ binary: fakeCli });
    const sessionId = await adapter.startSession(worktree, "do work");
    const result = await adapter.waitForCompletion(sessionId);

    const listArgs = JSON.parse(await readFile(argvList, "utf-8")) as string[];
    expect(listArgs[0]).toBe("list");
    expect(listArgs).toContain("--format");
    expect(listArgs[listArgs.indexOf("--format") + 1]).toBe("json");
    // The session ID was captured, which only happens when the list call's cwd
    // (the session working_directory) matched the worktree.
    expect(result.lastMessage).toBe("done");
  });

  it("reports success when the process exits with code 0", async () => {
    const adapter = new DevinAdapter({ binary: fakeCli });
    const sessionId = await adapter.startSession(worktree, "do work");
    const result = await adapter.waitForCompletion(sessionId);

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("reports failure and includes output when the process exits non-zero", async () => {
    process.env.FAKE_DEVIN_EXIT = "1";
    process.env.FAKE_DEVIN_RESPONSE = "something went wrong";
    const adapter = new DevinAdapter({ binary: fakeCli });
    const sessionId = await adapter.startSession(worktree, "do work");
    const result = await adapter.waitForCompletion(sessionId);

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    // Full output is preserved for diagnostics on failure
    expect(result.output).toContain("something went wrong");
  });

  it("extracts the lastMessage from stdout (the agent's print-mode response)", async () => {
    process.env.FAKE_DEVIN_RESPONSE = "Implemented the devin adapter with tests.";
    const adapter = new DevinAdapter({ binary: fakeCli });
    const sessionId = await adapter.startSession(worktree, "do work");
    const result = await adapter.waitForCompletion(sessionId);

    expect(result.lastMessage).toBe("Implemented the devin adapter with tests.");
  });

  it("captures the Devin native session ID via devin list for attach resume", async () => {
    process.env.FAKE_DEVIN_SESSION_ID = "devin-native-sess-abc";
    const adapter = new DevinAdapter({ binary: fakeCli });
    const orchestratorId = await adapter.startSession(worktree, "do work");
    await adapter.waitForCompletion(orchestratorId);

    // attach receives the orchestrator-generated ID but should resume using
    // Devin's native session ID captured via `devin list`.
    const session = await adapter.attach(orchestratorId);
    let output = "";
    session.onOutput((chunk) => {
      output += chunk;
    });
    await waitForSubstring(() => output, "resumed session");
    await session.detach();

    const args = JSON.parse(await readFile(argvResume, "utf-8")) as string[];
    expect(args).toContain("-r");
    expect(args[args.indexOf("-r") + 1]).toBe("devin-native-sess-abc");
  });

  it("falls back to the orchestrator session ID when devin list returns no session", async () => {
    process.env.FAKE_DEVIN_SKIP_LIST = "1";
    const adapter = new DevinAdapter({ binary: fakeCli });
    const orchestratorId = await adapter.startSession(worktree, "do work");
    await adapter.waitForCompletion(orchestratorId);

    const session = await adapter.attach(orchestratorId);
    let output = "";
    session.onOutput((chunk) => {
      output += chunk;
    });
    await waitForSubstring(() => output, "resumed session " + orchestratorId);
    await session.detach();

    const args = JSON.parse(await readFile(argvResume, "utf-8")) as string[];
    expect(args[args.indexOf("-r") + 1]).toBe(orchestratorId);
  });

  it("attach resumes via devin -r <session_id> and streams output", async () => {
    const adapter = new DevinAdapter({ binary: fakeCli });
    const session = await adapter.attach("sess-123");

    let output = "";
    session.onOutput((chunk) => {
      output += chunk;
    });

    // Wait for the resume banner, then send a message the fake echoes back.
    await waitForSubstring(() => output, "resumed session sess-123");
    await session.send("please fix the bug");
    await waitForSubstring(() => output, "echo: please fix the bug");

    const args = JSON.parse(await readFile(argvResume, "utf-8")) as string[];
    expect(args).toContain("-r");
    expect(args[args.indexOf("-r") + 1]).toBe("sess-123");

    await session.detach();
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
 * Write a fake `devin` CLI script that records its argv per mode and behaves
 * per env vars:
 * - FAKE_DEVIN_EXIT (default "0"): process exit code in print mode
 * - FAKE_DEVIN_RESPONSE (default "done"): text printed in print mode
 * - FAKE_DEVIN_SESSION_ID (default "devin-sess-fake"): id returned by `devin list`
 * - FAKE_DEVIN_SKIP_LIST: when set, `devin list` prints an empty array
 */
async function writeFakeCli(
  path: string,
  files: { argvPrint: string; argvList: string; argvResume: string },
): Promise<void> {
  const script = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv;
const args = argv.slice(2);

// Resume mode: \`devin -r <session_id>\` (or --resume). Interactive — streams a
// banner and echoes stdin lines back on stdout until stdin closes.
if (args.includes("-r") || args.includes("--resume")) {
  writeFileSync(${JSON.stringify(files.argvResume)}, JSON.stringify(args));
  const idx = args.includes("-r") ? args.indexOf("-r") : args.indexOf("--resume");
  const sessionId = args[idx + 1] ?? "";
  process.stdout.write("resumed session " + sessionId + "\\n");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    process.stdout.write("echo: " + line + "\\n");
  });
  rl.on("close", () => process.exit(0));
  // Keep alive until stdin closes or the process is killed.
} else if (args[0] === "list") {
  // Session list mode: \`devin list --format json\`
  writeFileSync(${JSON.stringify(files.argvList)}, JSON.stringify(args));
  const skip = process.env.FAKE_DEVIN_SKIP_LIST;
  const id = process.env.FAKE_DEVIN_SESSION_ID ?? "devin-sess-fake";
  const sessions = skip
    ? []
    : [{ id, working_directory: process.cwd(), last_activity_at: Date.now() / 1000, title: "fake session" }];
  process.stdout.write(JSON.stringify(sessions) + "\\n");
  process.exit(0);
} else {
  // Print mode: \`devin -p --prompt-file <file> --permission-mode bypass ...\`
  writeFileSync(${JSON.stringify(files.argvPrint)}, JSON.stringify(args));
  process.stdout.write(process.env.FAKE_DEVIN_RESPONSE ?? "done");
  // Mimic real Devin: when stdin is a pipe, wait for EOF before exiting.
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.exit(Number(process.env.FAKE_DEVIN_EXIT ?? "0"));
  });
}
`;
  await writeFile(path, script, "utf-8");
  await chmod(path, 0o755);
}
