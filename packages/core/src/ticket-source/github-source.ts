import type { Ticket } from "@orchestrator/types";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { TicketSource } from "./ticket-source.js";

const execAsync = promisify(exec);

/**
 * GitHubTicketSource — fetches tickets from GitHub issues via `gh` CLI.
 * Dependencies are parsed from a structured convention in the issue body
 * (e.g., `<!-- deps: #12, #15 -->` written by the upstream grilling workflow).
 */
export class GitHubTicketSource implements TicketSource {
  constructor(
    private repo: string,
    private labelFilter?: string,
  ) {}

  async fetch(): Promise<Ticket[]> {
    const labelFlag = this.labelFilter ? `--label "${this.labelFilter}"` : "";
    const { stdout } = await execAsync(
      `gh issue list --repo ${this.repo} --json number,title,body,labels ${labelFlag}`,
    );
    const issues = JSON.parse(stdout) as Array<{
      number: number;
      title: string;
      body: string;
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
