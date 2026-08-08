import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalTicketSource } from "./local-source.js";

describe("LocalTicketSource", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "orchestrator-tickets-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reads a single markdown file with frontmatter and parses id, title, dependencies", async () => {
    await writeFile(
      join(tempDir, "001.md"),
      [
        "---",
        "id: TICKET-001",
        "title: Add hello world endpoint",
        "dependencies: []",
        "---",
        "Create a simple GET /hello endpoint that returns 'world'.",
      ].join("\n"),
    );

    const source = new LocalTicketSource(tempDir);
    const tickets = await source.fetch();

    expect(tickets).toHaveLength(1);
    const ticket = tickets[0];
    expect(ticket.id).toBe("TICKET-001");
    expect(ticket.title).toBe("Add hello world endpoint");
    expect(ticket.source).toBe("local");
    expect(ticket.dependencies).toEqual([]);
    expect(ticket.body).toContain("Create a simple GET /hello endpoint");
    expect(ticket.sourceRef).toBe(join(tempDir, "001.md"));
  });

  it("parses dependencies from frontmatter", async () => {
    await writeFile(
      join(tempDir, "002.md"),
      [
        "---",
        "id: TICKET-002",
        "title: Add tests for hello endpoint",
        "dependencies: [TICKET-001, TICKET-003]",
        "---",
        "Write unit tests for the hello endpoint.",
      ].join("\n"),
    );

    const source = new LocalTicketSource(tempDir);
    const tickets = await source.fetch();

    expect(tickets[0].dependencies).toEqual(["TICKET-001", "TICKET-003"]);
  });

  it("uses a prompt from frontmatter when present", async () => {
    await writeFile(
      join(tempDir, "003.md"),
      [
        "---",
        "id: TICKET-003",
        "title: Custom task",
        "prompt: Do the thing exactly this way",
        "---",
        "This is the body.",
      ].join("\n"),
    );

    const source = new LocalTicketSource(tempDir);
    const tickets = await source.fetch();

    expect(tickets[0].prompt).toBe("Do the thing exactly this way");
  });

  it("derives title from first heading when frontmatter has no title", async () => {
    await writeFile(
      join(tempDir, "004.md"),
      [
        "---",
        "id: TICKET-004",
        "---",
        "# Implied Title from Heading",
        "",
        "Body content here.",
      ].join("\n"),
    );

    const source = new LocalTicketSource(tempDir);
    const tickets = await source.fetch();

    expect(tickets[0].title).toBe("Implied Title from Heading");
  });

  it("skips files without frontmatter", async () => {
    await writeFile(join(tempDir, "no-frontmatter.md"), "Just some markdown content.");
    await writeFile(
      join(tempDir, "001.md"),
      [
        "---",
        "id: TICKET-001",
        "title: Real ticket",
        "---",
        "Body.",
      ].join("\n"),
    );

    const source = new LocalTicketSource(tempDir);
    const tickets = await source.fetch();

    expect(tickets).toHaveLength(1);
    expect(tickets[0].id).toBe("TICKET-001");
  });

  it("parses labels from frontmatter", async () => {
    await writeFile(
      join(tempDir, "005.md"),
      [
        "---",
        "id: TICKET-005",
        "title: Labeled ticket",
        "labels: [bug, urgent]",
        "---",
        "Body.",
      ].join("\n"),
    );

    const source = new LocalTicketSource(tempDir);
    const tickets = await source.fetch();

    expect(tickets[0].labels).toEqual(["bug", "urgent"]);
  });
});
