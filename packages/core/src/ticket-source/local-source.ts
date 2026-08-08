import type { Ticket } from "@orchestrator/types";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TicketSource } from "./ticket-source.js";

interface ParsedFrontmatter {
  id?: string;
  title?: string;
  labels?: string[];
  dependencies?: string[];
  prompt?: string;
}

/**
 * LocalTicketSource — fetches tickets from local Markdown files with YAML frontmatter.
 * Frontmatter fields: id, title, labels, dependencies, prompt (optional).
 * Body is the Markdown content after the frontmatter.
 */
export class LocalTicketSource implements TicketSource {
  constructor(private directory: string) {}

  async fetch(): Promise<Ticket[]> {
    const files = await readdir(this.directory);
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    const tickets: Ticket[] = [];

    for (const file of mdFiles) {
      const filePath = join(this.directory, file);
      const content = await readFile(filePath, "utf-8");
      const ticket = this.parseTicket(content, filePath);
      if (ticket) tickets.push(ticket);
    }

    return tickets;
  }

  private parseTicket(content: string, filePath: string): Ticket | null {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!frontmatterMatch) return null;

    const frontmatterText = frontmatterMatch[1];
    const body = frontmatterMatch[2].trim();
    const fm = this.parseFrontmatter(frontmatterText);

    return {
      id: fm.id ?? filePath,
      source: "local",
      title: fm.title ?? body.split("\n")[0]?.replace(/^#+\s*/, "") ?? "Untitled",
      body,
      labels: fm.labels ?? [],
      dependencies: fm.dependencies ?? [],
      prompt: fm.prompt,
      sourceRef: filePath,
    };
  }

  private parseFrontmatter(text: string): ParsedFrontmatter {
    const result: ParsedFrontmatter = {};
    for (const line of text.split("\n")) {
      const match = line.match(/^(\w+):\s*(.*)$/);
      if (!match) continue;
      const [, key, value] = match;
      if (value.startsWith("[") && value.endsWith("]")) {
        const arr = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        if (key === "labels" || key === "dependencies") {
          result[key] = arr;
        }
      } else {
        const str = value.replace(/^["']|["']$/g, "");
        if (key === "id" || key === "title" || key === "prompt") {
          result[key] = str;
        }
      }
    }
    return result;
  }
}
