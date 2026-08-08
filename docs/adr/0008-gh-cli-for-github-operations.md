# gh CLI for all GitHub operations

The orchestrator uses the `gh` CLI (GitHub CLI) for all GitHub operations — reading issues, creating PRs, and merging PRs. It shells out to `gh` rather than using the GitHub API directly via Octokit.

We chose this to stay consistent with the CLI-subprocess philosophy used for adapters: delegate to existing CLI tools rather than coupling to APIs. `gh` handles authentication (browser flow, token storage), API calls, and error handling. No GitHub API dependency, no token management, no Octokit in the orchestrator code. `gh` is a documented prerequisite. The alternative (direct API via Octokit) would add API coupling and auth complexity for no real benefit.
