# Monorepo with workspaces for package structure

The project is structured as a monorepo using npm/pnpm workspaces. The core orchestrator, the TUI, and the built-in adapters (Devin, Codex) are separate packages developed together in the monorepo and published independently to NPM. External adapter authors create standalone packages outside the monorepo following the `@orchestrator/adapter-<name>` naming convention.

We chose this over a single package (which contradicts the NPM adapter distribution model) and separate repos per adapter (which creates coordination overhead for shared types and atomic changes). The monorepo gives us development convenience — shared types, atomic changes across packages, unified tooling — while preserving distribution flexibility: each package is independently versioned and installable.
