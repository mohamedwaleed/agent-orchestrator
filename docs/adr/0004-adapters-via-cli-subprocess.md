# Adapters interface with agents via CLI subprocess

Adapters communicate with coding agents by spawning their CLI as a child process, not via API or SDK. Completion is detected via process exit code. JSON output is parsed for structured results. Session resume flags (e.g., `devin -r <session_id>`, `codex exec resume <session_id>`) are used for attach functionality.

We chose this over API/SDK integration because both Devin CLI and Codex CLI already provide non-interactive execution modes, working directory selection, session resume, and JSON output — everything the Adapter contract needs. CLI subprocess keeps adapters thin (subprocess management + output parsing), avoids API version coupling and authentication complexity, and upholds the agent-agnostic promise: any agent with a CLI can be supported by writing a thin adapter. API/SDK integration would be richer but couples each adapter to a specific API version and limits extensibility to agents that expose APIs.
