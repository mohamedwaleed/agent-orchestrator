import type { Adapter } from "@orchestrator/types";

/**
 * AdapterRegistry — discovers and manages adapter instances.
 * Adapters are NPM packages following the naming convention @orchestrator/adapter-<name>.
 * The registry auto-discovers installed adapter packages in node_modules.
 */
export class AdapterRegistry {
  private adapters = new Map<string, Adapter>();

  /**
   * Register an adapter instance manually.
   * Used for built-in adapters and testing.
   */
  register(adapter: Adapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /**
   * Get an adapter by name.
   */
  getAdapter(name: string): Adapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(
        `Adapter "${name}" not found. Install it via: pnpm add @orchestrator/adapter-${name}`,
      );
    }
    return adapter;
  }

  /**
   * List all registered adapter names.
   */
  listAdapters(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Auto-discover installed adapter packages in node_modules.
   * Scans for packages matching the @orchestrator/adapter-* naming convention.
   * TODO: implement dynamic import-based discovery.
   */
  async autoDiscover(): Promise<void> {
    // Placeholder — will scan node_modules for @orchestrator/adapter-* packages
    // and dynamically import them.
  }
}
