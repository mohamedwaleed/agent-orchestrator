import type { Ticket } from "@orchestrator/types";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { TicketSource } from "./ticket-source.js";

const execAsync = promisify(exec);

/**
 * CommandRunner — executes a shell command and returns its stdout.
 * Injected so tests can intercept `gh` calls without spawning a real process.
 * The default implementation shells out via `child_process.exec`.
 */
export type CommandRunner = (command: string) => Promise<string>;

/** Default CommandRunner that shells out via `child_process.exec`. */
async function defaultCommandRunner(command: string): Promise<string> {
  const { stdout } = await execAsync(command);
  return stdout;
}

/**
 * GitHubTicketSource — fetches tickets from GitHub issues via `gh` CLI.
 * Dependencies are parsed from a structured convention in the issue body
 * (e.g., `<!-- deps: #12, #15 -->` written by the upstream grilling workflow).
 */
export class GitHubTicketSource implements TicketSource {
  private runCommand: CommandRunner;

  constructor(
    private repo: string,
    private labelFilter?: string,
    commandRunner?: CommandRunner,
  ) {
    this.runCommand = commandRunner ?? defaultCommandRunner;
  }

  async fetch(): Promise<Ticket[]> {
    const labelFlag = this.labelFilter ? ` --label "${this.labelFilter}"` : "";
    const stdout = await this.runCommand(
      `gh issue list --repo ${this.repo} --json number,title,body,labels${labelFlag}`,
    );
    const issues = JSON.parse(stdout) as Array<{
      number: number;
      title: string;
      body: string | null;
      labels: Array<{ name: string }>;
    }>;

    return issues.map((issue) => ({
      id: String(issue.number),
      source: "github" as const,
      title: issue.title,
      body: issue.body ?? "",
      labels: issue.labels.map((l) => l.name),
      dependencies: this.parseDependencies(issue.body ?? ""),
      sourceRef: `https://github.com/${this.repo}/issues/${issue.number}`,
    }));
  }

  /**
   * Parse dependencies from the issue body convention:
   * `<!-- deps: #12, #15 -->`
   */
  private parseDependencies(body: string): string[] {
    const match = body.match(/<!--\s*deps:\s*([^>]+)-->/);
    if (!match) return [];
    return match[1]
      .split(",")
      .map((s) => s.trim().replace(/^#/, ""))
      .filter(Boolean);
  }
}
