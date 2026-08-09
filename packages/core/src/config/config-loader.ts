import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { OrchestratorConfig as Config, TicketSourceConfig } from "@orchestrator/types";

export type { OrchestratorConfig, TicketSourceConfig } from "@orchestrator/types";

const DEFAULTS: Config = {
  adapter: "devin",
  baseBranch: "main",
  mergeGate: true,
  plannerProvider: "openai",
  plannerModel: "gpt-4o",
  ticketSource: { kind: "github", ref: "" },
};

export interface ConfigLoaderOptions {
  /** Override the global config file path (for testing). */
  globalPath?: string;
  /** Override the repo-level config file path (for testing). */
  repoPath?: string;
}

/**
 * ConfigLoader — loads layered configuration for the orchestrator.
 *
 * Three layers, each overriding the one below:
 * 1. Global config (~/.config/orchestrator/config.yml) — user-wide defaults
 * 2. Repo-level config (.orchestrator/config.yml) — team-shared settings
 * 3. CLI flags — one-off overrides
 *
 * Layers are deep-merged so nested objects (like `ticketSource`) combine
 * field-by-field rather than being wholesale replaced.
 */
export class ConfigLoader {
  private readonly globalPath: string;
  private readonly repoPath: string;

  constructor(options: ConfigLoaderOptions = {}) {
    this.globalPath =
      options.globalPath ??
      join(process.env.HOME ?? "", ".config/orchestrator/config.yml");
    this.repoPath = options.repoPath ?? ".orchestrator/config.yml";
  }

  load(cliOverrides?: Partial<Config>): Config {
    const global = this.loadFile(this.globalPath);
    const repo = this.loadFile(this.repoPath);

    return mergeConfig(mergeConfig(mergeConfig(DEFAULTS, global), repo), cliOverrides ?? {});
  }

  private loadFile(path: string): Partial<Config> {
    if (!existsSync(path)) return {};
    const content = readFileSync(path, "utf-8");
    return this.parseYaml(content);
  }

  private parseYaml(content: string): Partial<Config> {
    const parsed = parseYaml(content);
    if (parsed === null || typeof parsed !== "object") return {};
    return parsed as Partial<Config>;
  }
}

/**
 * Deep-merge two configs. `overrides` takes precedence over `base`.
 * Nested objects (e.g. `ticketSource`) are merged field-by-field.
 */
function mergeConfig(base: Config, overrides: Partial<Config>): Config {
  const result: Config = { ...base };

  for (const key of Object.keys(overrides) as (keyof Config)[]) {
    const overrideValue = overrides[key];
    if (overrideValue === undefined) continue;

    if (key === "ticketSource" && typeof overrideValue === "object" && overrideValue !== null) {
      result.ticketSource = {
        ...base.ticketSource,
        ...(overrideValue as TicketSourceConfig),
      };
    } else {
      (result[key] as Config[keyof Config]) = overrideValue as Config[keyof Config];
    }
  }

  return result;
}
