import type { GitOperations } from "./git-operations.js";
import { exec as execChildProcess } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execChildProcess);

/**
 * RealGitOperations — shells out to git and gh CLI for real operations.
 * Used in production. For tests, a fake implementation is injected instead.
 */
export class RealGitOperations implements GitOperations {
  async createWorktree(branchName: string, worktreePath: string, baseBranch: string): Promise<void> {
    // Fetch the latest remote state so worktrees branch from up-to-date code.
    // Without this, the local base branch may be behind origin, causing PR
    // merge conflicts when the PR targets the remote base branch.
    await exec(`git fetch origin ${baseBranch}`);

    // Clean up any stale worktree/branch from a previous failed run so re-runs
    // are idempotent. git worktree metadata is not safe under concurrent adds,
    // but these cleanups are sequential and best-effort — failures are ignored.
    await exec(`git worktree remove --force ${worktreePath} 2>/dev/null || true`);
    await exec(`git branch -D ${branchName} 2>/dev/null || true`);
    await exec(`git worktree add -b ${branchName} ${worktreePath} origin/${baseBranch}`);
  }

  async commitAll(worktreePath: string, message: string): Promise<void> {
    await exec(`git -C ${worktreePath} add -A`);
    await exec(`git -C ${worktreePath} commit -m ${shellQuote(message)}`);
  }

  async push(worktreePath: string, branchName: string): Promise<void> {
    await exec(`git -C ${worktreePath} push -u --force origin ${branchName}`);
  }

  async createPR(title: string, body: string, baseBranch: string, headBranch: string): Promise<{ url: string; number: number }> {
    const { stdout } = await exec(
      `gh pr create --title ${shellQuote(title)} --body ${shellQuote(body)} --base ${baseBranch} --head ${headBranch}`,
    );
    const url = stdout.trim();
    // Extract PR number from URL (e.g., https://github.com/owner/repo/pull/42)
    const match = url.match(/\/pull\/(\d+)$/);
    const number = match ? parseInt(match[1], 10) : 0;
    return { url, number };
  }

  async mergePR(prUrl: string): Promise<void> {
    // Don't use --delete-branch: the local branch is still checked out in a
    // worktree (worktrees persist through the entire Run per the spec), so
    // gh can't delete it. The remote branch is deleted by GitHub's squash
    // merge; the local branch is cleaned up with the worktree after completion.
    await exec(`gh pr merge ${prUrl} --squash`);
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    await exec(`git worktree remove --force ${worktreePath}`);
  }
}

/** Shell-quote a string for safe use as a single argument. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
