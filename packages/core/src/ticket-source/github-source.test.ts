import { describe, it, expect } from "vitest";
import { GitHubTicketSource } from "./github-source.js";

// ---------------------------------------------------------------------------
// Fake command runner — intercepts `gh` shell commands, records calls, and
// returns configurable stdout. Matches the spec's "Fake git/gh operations"
// pattern: no real `gh` CLI is spawned.
// ---------------------------------------------------------------------------

interface RecordedCall {
  command: string;
}

function makeFakeRunner(stdout: string): { runner: (cmd: string) => Promise<string>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner = (command: string): Promise<string> => {
    calls.push({ command });
    return Promise.resolve(stdout);
  };
  return { runner, calls };
}

// Minimal shape returned by `gh issue list --json number,title,body,labels`
function issueJson(issues: Array<{ number: number; title: string; body: string | null; labels: string[] }>): string {
  return JSON.stringify(
    issues.map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body,
      labels: i.labels.map((name) => ({ name })),
    })),
  );
}

describe("GitHubTicketSource", () => {
  it("fetches issues via `gh issue list --json number,title,body,labels` and maps them to the common Ticket shape", async () => {
    const { runner, calls } = makeFakeRunner(
      issueJson([
        { number: 4, title: "GitHub ticket source", body: "Add a GitHub ticket source.", labels: ["ready-for-agent"] },
      ]),
    );
    const source = new GitHubTicketSource("mohamedwaleed/agent-orchestrator", undefined, runner);

    const tickets = await source.fetch();

    expect(tickets).toHaveLength(1);
    const ticket = tickets[0];
    expect(ticket.id).toBe("4");
    expect(ticket.source).toBe("github");
    expect(ticket.title).toBe("GitHub ticket source");
    expect(ticket.body).toBe("Add a GitHub ticket source.");
    expect(ticket.labels).toEqual(["ready-for-agent"]);
    expect(ticket.dependencies).toEqual([]); // no deps block → empty
    expect(ticket.sourceRef).toBe("https://github.com/mohamedwaleed/agent-orchestrator/issues/4");

    // The gh command requested the documented JSON fields
    expect(calls[0].command).toBe(
      "gh issue list --repo mohamedwaleed/agent-orchestrator --json number,title,body,labels",
    );
  });

  it("passes an optional --label filter through to `gh issue list`", async () => {
    const { runner, calls } = makeFakeRunner(issueJson([]));
    const source = new GitHubTicketSource("owner/repo", "parallelizable", runner);

    await source.fetch();

    expect(calls[0].command).toBe(
      'gh issue list --repo owner/repo --json number,title,body,labels --label "parallelizable"',
    );
  });

  it("omits the --label flag when no label filter is given", async () => {
    const { runner, calls } = makeFakeRunner(issueJson([]));
    const source = new GitHubTicketSource("owner/repo", undefined, runner);

    await source.fetch();

    expect(calls[0].command).not.toContain("--label");
  });

  it("parses dependencies from a `<!-- deps: #12, #15 -->` block in the issue body", async () => {
    const { runner } = makeFakeRunner(
      issueJson([
        {
          number: 20,
          title: "Dependent task",
          body: "Some description.\n\n<!-- deps: #12, #15 -->\n",
          labels: [],
        },
      ]),
    );
    const source = new GitHubTicketSource("owner/repo", undefined, runner);

    const tickets = await source.fetch();

    expect(tickets[0].dependencies).toEqual(["12", "15"]);
  });

  it("defaults to an empty dependencies array when the issue body has no deps block", async () => {
    const { runner } = makeFakeRunner(
      issueJson([{ number: 7, title: "Standalone", body: "No deps here.", labels: [] }]),
    );
    const source = new GitHubTicketSource("owner/repo", undefined, runner);

    const tickets = await source.fetch();

    expect(tickets[0].dependencies).toEqual([]);
  });

  it("handles a null issue body as an empty body with no dependencies", async () => {
    const { runner } = makeFakeRunner(
      issueJson([{ number: 8, title: "Empty body", body: null, labels: [] }]),
    );
    const source = new GitHubTicketSource("owner/repo", undefined, runner);

    const tickets = await source.fetch();

    expect(tickets[0].body).toBe("");
    expect(tickets[0].dependencies).toEqual([]);
  });

  it("maps multiple issues and sets sourceRef to each issue's URL", async () => {
    const { runner } = makeFakeRunner(
      issueJson([
        { number: 1, title: "First", body: "<!-- deps: #2 -->", labels: ["a"] },
        { number: 2, title: "Second", body: "No deps.", labels: [] },
      ]),
    );
    const source = new GitHubTicketSource("owner/repo", undefined, runner);

    const tickets = await source.fetch();

    expect(tickets).toHaveLength(2);
    expect(tickets[0].id).toBe("1");
    expect(tickets[0].sourceRef).toBe("https://github.com/owner/repo/issues/1");
    expect(tickets[0].dependencies).toEqual(["2"]);
    expect(tickets[1].id).toBe("2");
    expect(tickets[1].sourceRef).toBe("https://github.com/owner/repo/issues/2");
    expect(tickets[1].dependencies).toEqual([]);
  });
});
