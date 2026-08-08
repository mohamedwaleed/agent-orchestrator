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
    await exec(`git worktree add -b ${branchName} ${worktreePath} ${baseBranch}`);
  }

  async commitAll(worktreePath: string, message: string): Promise<void> {
    await exec(`git -C ${worktreePath} add -A`);
    await exec(`git -C ${worktreePath} commit -m ${shellQuote(message)}`);
  }

  async push(worktreePath: string, branchName: string): Promise<void> {
    await exec(`git -C ${worktreePath} push -u origin ${branchName}`);
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
    await exec(`gh pr merge ${prUrl} --squash --delete-branch`);
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    await exec(`git worktree remove --force ${worktreePath}`);
  }
}

/** Shell-quote a string for safe use as a single argument. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
