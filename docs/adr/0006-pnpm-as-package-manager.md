# pnpm as the package manager

The monorepo uses pnpm with workspaces. We chose pnpm over npm and yarn because its strict dependency resolution prevents phantom dependencies (critical in a monorepo with shared types), its content-addressable store saves disk space across packages with overlapping dependencies, and its install speed is noticeably faster during development. The trade-off is that pnpm requires a global install, but that's a one-line setup step.
