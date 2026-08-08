import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { OrchestratorConfig as Config } from "@orchestrator/types";

export type { OrchestratorConfig, TicketSourceConfig } from "@orchestrator/types";

/**
 * ConfigLoader — loads layered configuration for the orchestrator.
 *
 * Three layers, each overriding the one below:
 * 1. Global config (~/.config/orchestrator/config.yml) — user-wide defaults
 * 2. Repo-level config (.orchestrator/config.yml) — team-shared settings
 * 3. CLI flags — one-off overrides
 *
 * TODO: implement YAML parsing and layer merging.
 * For now, this is a stub for scaffolding.
 */
export class ConfigLoader {
  private static readonly GLOBAL_PATH = join(
    process.env.HOME ?? "",
    ".config/orchestrator/config.yml",
  );
  private static readonly REPO_PATH = ".orchestrator/config.yml";

  load(cliOverrides?: Partial<Config>): Config {
    const global = this.loadFile(ConfigLoader.GLOBAL_PATH);
    const repo = this.loadFile(ConfigLoader.REPO_PATH);

    return {
      adapter: "devin",
      baseBranch: "main",
      mergeGate: false,
      plannerProvider: "openai",
      plannerModel: "gpt-4o",
      ticketSource: { kind: "github", ref: "" },
      ...global,
      ...repo,
      ...cliOverrides,
    };
  }

  private loadFile(path: string): Partial<Config> {
    if (!existsSync(path)) return {};
    // TODO: parse YAML
    const content = readFileSync(path, "utf-8");
    return this.parseYaml(content);
  }

  private parseYaml(_content: string): Partial<Config> {
    // Simple stub — will be replaced with proper YAML parser
    return {};
  }
}
