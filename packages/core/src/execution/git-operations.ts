/**
 * GitOperations — abstracts git and gh CLI operations.
 * This interface is the seam between the WaveExecutor and the real git/gh commands.
 * In production, RealGitOperations shells out to git and gh.
 * In tests, a fake implementation records calls and returns configurable results.
 */
export interface GitOperations {
  /** Create a worktree branched from the base branch. Returns the worktree path. */
  createWorktree(branchName: string, worktreePath: string, baseBranch: string): Promise<void>;

  /** Stage all changes and commit with the given message. */
  commitAll(worktreePath: string, message: string): Promise<void>;

  /** Push the branch to the remote. */
  push(worktreePath: string, branchName: string): Promise<void>;

  /** Create a PR via gh CLI. Returns the PR URL and number. */
  createPR(title: string, body: string, baseBranch: string, headBranch: string): Promise<{ url: string; number: number }>;

  /** Merge a PR via gh CLI. Throws on conflict. */
  mergePR(prUrl: string): Promise<void>;

  /** Remove a worktree. */
  removeWorktree(worktreePath: string): Promise<void>;
}
