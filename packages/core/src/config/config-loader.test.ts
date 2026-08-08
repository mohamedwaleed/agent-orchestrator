import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigLoader } from "./config-loader.js";

describe("ConfigLoader", () => {
  let globalDir: string;
  let repoDir: string;
  let globalConfigPath: string;
  let repoConfigPath: string;

  beforeEach(async () => {
    globalDir = await mkdtemp(join(tmpdir(), "orch-global-"));
    repoDir = await mkdtemp(join(tmpdir(), "orch-repo-"));
    globalConfigPath = join(globalDir, "config.yml");
    repoConfigPath = join(repoDir, "config.yml");
  });

  afterEach(async () => {
    await rm(globalDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  function loader(): ConfigLoader {
    return new ConfigLoader({ globalPath: globalConfigPath, repoPath: repoConfigPath });
  }

  // -------------------------------------------------------------------------
  // Defaults
  // -------------------------------------------------------------------------

  it("returns sensible defaults when no config files exist", () => {
    const config = loader().load();

    expect(config.adapter).toBe("devin");
    expect(config.baseBranch).toBe("main");
    expect(config.mergeGate).toBe(false);
    expect(config.plannerProvider).toBe("openai");
    expect(config.plannerModel).toBe("gpt-4o");
    expect(config.ticketSource).toEqual({ kind: "github", ref: "" });
  });

  it("handles missing config files gracefully without throwing", () => {
    expect(() => loader().load()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Global config layer
  // -------------------------------------------------------------------------

  it("reads global config from YAML if it exists", async () => {
    await writeFile(
      globalConfigPath,
      ["adapter: codex", "baseBranch: master", "mergeGate: true"].join("\n"),
    );

    const config = loader().load();

    expect(config.adapter).toBe("codex");
    expect(config.baseBranch).toBe("master");
    expect(config.mergeGate).toBe(true);
  });

  it("reads plannerProvider and plannerModel from global config", async () => {
    await writeFile(
      globalConfigPath,
      ["plannerProvider: anthropic", "plannerModel: claude-3-opus"].join("\n"),
    );

    const config = loader().load();

    expect(config.plannerProvider).toBe("anthropic");
    expect(config.plannerModel).toBe("claude-3-opus");
  });

  it("reads promptTemplatePath from global config", async () => {
    await writeFile(globalConfigPath, "promptTemplatePath: /home/user/template.md");

    const config = loader().load();

    expect(config.promptTemplatePath).toBe("/home/user/template.md");
  });

  it("reads nested ticketSource from global config", async () => {
    await writeFile(
      globalConfigPath,
      [
        "ticketSource:",
        "  kind: local",
        "  ref: ./tickets/",
        '  filter: "*.md"',
      ].join("\n"),
    );

    const config = loader().load();

    expect(config.ticketSource).toEqual({ kind: "local", ref: "./tickets/", filter: "*.md" });
  });

  // -------------------------------------------------------------------------
  // Repo-level config layer
  // -------------------------------------------------------------------------

  it("reads repo-level config from YAML if it exists", async () => {
    await writeFile(
      repoConfigPath,
      ["adapter: codex", "baseBranch: develop"].join("\n"),
    );

    const config = loader().load();

    expect(config.adapter).toBe("codex");
    expect(config.baseBranch).toBe("develop");
  });

  it("repo-level overrides global config", async () => {
    await writeFile(globalConfigPath, "adapter: devin\nbaseBranch: main");
    await writeFile(repoConfigPath, "adapter: codex");

    const config = loader().load();

    expect(config.adapter).toBe("codex");
    expect(config.baseBranch).toBe("main"); // global value preserved
  });

  it("repo-level ticketSource overrides global ticketSource", async () => {
    await writeFile(
      globalConfigPath,
      ["ticketSource:", "  kind: github", "  ref: owner/repo"].join("\n"),
    );
    await writeFile(
      repoConfigPath,
      ["ticketSource:", "  kind: local", "  ref: ./tasks/"].join("\n"),
    );

    const config = loader().load();

    expect(config.ticketSource).toEqual({ kind: "local", ref: "./tasks/" });
  });

  // -------------------------------------------------------------------------
  // CLI overrides
  // -------------------------------------------------------------------------

  it("CLI overrides repo-level config", async () => {
    await writeFile(repoConfigPath, "adapter: codex\nbaseBranch: develop");

    const config = loader().load({ adapter: "devin" });

    expect(config.adapter).toBe("devin");
    expect(config.baseBranch).toBe("develop"); // repo value preserved
  });

  it("CLI overrides global config when no repo config exists", async () => {
    await writeFile(globalConfigPath, "adapter: codex");

    const config = loader().load({ adapter: "devin" });

    expect(config.adapter).toBe("devin");
  });

  it("CLI baseBranch override works", async () => {
    await writeFile(repoConfigPath, "baseBranch: main");

    const config = loader().load({ baseBranch: "feature-x" });

    expect(config.baseBranch).toBe("feature-x");
  });

  it("CLI mergeGate override works", async () => {
    await writeFile(repoConfigPath, "mergeGate: false");

    const config = loader().load({ mergeGate: true });

    expect(config.mergeGate).toBe(true);
  });

  it("CLI ticketSource override works", async () => {
    const config = loader().load({
      ticketSource: { kind: "github", ref: "owner/repo", filter: "bug" },
    });

    expect(config.ticketSource).toEqual({ kind: "github", ref: "owner/repo", filter: "bug" });
  });

  // -------------------------------------------------------------------------
  // Three-layer merge
  // -------------------------------------------------------------------------

  it("merges all three layers: global → repo → CLI", async () => {
    await writeFile(
      globalConfigPath,
      [
        "adapter: devin",
        "baseBranch: main",
        "mergeGate: false",
        "plannerProvider: openai",
        "plannerModel: gpt-4o",
      ].join("\n"),
    );
    await writeFile(
      repoConfigPath,
      [
        "adapter: codex",
        "mergeGate: true",
        "plannerModel: gpt-4o-mini",
      ].join("\n"),
    );

    const config = loader().load({
      adapter: "claude",
      baseBranch: "develop",
    });

    // CLI wins
    expect(config.adapter).toBe("claude");
    expect(config.baseBranch).toBe("develop");
    // Repo wins (no CLI override)
    expect(config.mergeGate).toBe(true);
    expect(config.plannerModel).toBe("gpt-4o-mini");
    // Global wins (no repo or CLI override)
    expect(config.plannerProvider).toBe("openai");
  });

  it("deep-merges ticketSource: CLI filter overrides repo, repo kind overrides global", async () => {
    await writeFile(
      globalConfigPath,
      ["ticketSource:", "  kind: github", "  ref: owner/repo", "  filter: bug"].join("\n"),
    );
    await writeFile(
      repoConfigPath,
      ["ticketSource:", "  kind: local", "  ref: ./tasks/"].join("\n"),
    );

    const config = loader().load({
      ticketSource: { kind: "local", ref: "./tasks/", filter: "urgent" },
    });

    expect(config.ticketSource).toEqual({ kind: "local", ref: "./tasks/", filter: "urgent" });
  });

  // -------------------------------------------------------------------------
  // Default paths (no injection)
  // -------------------------------------------------------------------------

  it("uses default paths when no paths are injected", () => {
    const defaultLoader = new ConfigLoader();
    // Should not throw — missing files are handled gracefully
    expect(() => defaultLoader.load()).not.toThrow();
  });
});
