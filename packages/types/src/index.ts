/**
 * Shared types for the Agent Orchestrator.
 * These types define the contracts between the core orchestrator, adapters, and TUI.
 * See CONTEXT.md for the ubiquitous language definitions.
 */

// ---------------------------------------------------------------------------
// Ticket — raw input from an upstream source (GitHub issue or local file)
// ---------------------------------------------------------------------------

export type TicketSourceKind = "github" | "local";

export interface Ticket {
  /** Unique identifier — GitHub issue number or local file ID from frontmatter */
  id: string;
  /** Source kind this ticket came from */
  source: TicketSourceKind;
  /** Human-readable title */
  title: string;
  /** Full description body (Markdown) */
  body: string;
  /** Labels from the source (GitHub labels or frontmatter labels) */
  labels: string[];
  /** IDs of tickets this ticket depends on (pre-declared upstream) */
  dependencies: string[];
  /** Optional pre-written prompt — if present, the Planner skips LLM generation */
  prompt?: string;
  /** Original source reference (e.g., GitHub issue URL or file path) */
  sourceRef: string;
}

// ---------------------------------------------------------------------------
// Task — a unit of work mapped 1:1 from a Ticket
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "conflicted";

export interface Task {
  /** Unique identifier — derived from the Ticket ID */
  id: string;
  /** The Ticket this task was mapped from (1:1) */
  ticketId: string;
  /** Human-readable title (from Ticket) */
  title: string;
  /** The prompt to send to the agent */
  prompt: string;
  /** IDs of tasks this task depends on */
  dependencies: string[];
  /** Wave number this task is assigned to (0-indexed) */
  wave: number;
  /** Adapter to use for this task */
  adapter: string;
  /** Current lifecycle status */
  status: TaskStatus;
  /** Non-blocking size warning from the Planner, if any */
  sizeWarning?: string;
  /** Session ID once the agent has been started */
  sessionId?: string;
  /** Path to the git worktree for this task */
  worktreePath?: string;
  /** PR number once the PR has been created */
  prNumber?: number;
  /** PR URL once the PR has been created */
  prUrl?: string;
  /** User modification messages logged during Attach (audit trail) */
  attachMessages: AttachMessage[];
}

export interface AttachMessage {
  timestamp: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Plan — output of the Planner, subject to Approval Gate
// ---------------------------------------------------------------------------

export interface Plan {
  /** All tasks in the plan */
  tasks: Task[];
  /** The dependency graph as an adjacency list (taskId -> dependencyIds) */
  dependencyGraph: Record<string, string[]>;
  /** Waves as arrays of task IDs — each wave runs in parallel */
  waves: string[][];
  /** The base branch the plan was created against */
  baseBranch: string;
}

// ---------------------------------------------------------------------------
// Adapter contract — the interface adapters must implement
// ---------------------------------------------------------------------------

export interface AdapterResult {
  /** Whether the agent completed its task successfully */
  success: boolean;
  /** Process exit code */
  exitCode: number;
  /** Full agent stdout/stderr output */
  output: string;
  /** Agent's final summary message — used in the PR body */
  lastMessage: string;
}

export interface InteractiveSession {
  /** Send a message to the agent */
  send(message: string): Promise<void>;
  /** Subscribe to streaming output from the agent */
  onOutput(callback: (chunk: string) => void): void;
  /** Detach from the session — returns whether the user resolved the issue */
  detach(): Promise<boolean>;
}

export interface Adapter {
  /** Unique adapter name (e.g., "devin", "codex") */
  name: string;

  /**
   * Start an agent session in the given worktree with the task prompt.
   * The agent must run in automatic accept mode — no approval prompts.
   * Returns a session ID that can be used with wait_for_completion and attach.
   */
  startSession(worktreePath: string, prompt: string): Promise<string>;

  /**
   * Block until the agent session completes.
   * The adapter implementation chooses how to detect completion internally
   * (process exit, polling, event listening, etc.).
   */
  waitForCompletion(sessionId: string): Promise<AdapterResult>;

  /**
   * Attach to an active session for real-time interaction.
   * The user can observe the agent and send messages to command modifications.
   */
  attach(sessionId: string): Promise<InteractiveSession>;
}

// ---------------------------------------------------------------------------
// Run — a single execution of the orchestrator
// ---------------------------------------------------------------------------

export type RunPhase =
  | "intake"
  | "planning"
  | "approval"
  | "execution"
  | "completion"
  | "intervention";

export interface RunState {
  /** Unique run identifier */
  id: string;
  /** Current phase of the run */
  phase: RunPhase;
  /** The plan being executed (set after Approval Gate) */
  plan?: Plan;
  /** Current wave being executed (0-indexed) */
  currentWave: number;
  /** All tasks and their current statuses */
  tasks: Task[];
  /** Timestamps */
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Config — layered configuration
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  /** Default adapter name */
  adapter: string;
  /** Base branch for worktrees and PRs */
  baseBranch: string;
  /** Whether the merge gate is enabled between waves */
  mergeGate: boolean;
  /** Planner LLM provider (e.g., "openai", "anthropic", "ollama") */
  plannerProvider: string;
  /** Planner LLM model name */
  plannerModel: string;
  /** Path to the prompt template file */
  promptTemplatePath?: string;
  /** Ticket source configuration */
  ticketSource: TicketSourceConfig;
}

export interface TicketSourceConfig {
  kind: TicketSourceKind;
  /** For GitHub: "owner/repo". For local: directory path. */
  ref: string;
  /** Optional filter — GitHub: label filter. Local: glob pattern. */
  filter?: string;
}
