import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StaticApprovalProvider } from "@clero-local-agent/approvals";
import { GitTools } from "@clero-local-agent/git-tools";
import { WorkspacePolicy } from "@clero-local-agent/workspace";

test("git tools list, switch, and create branches", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "clero-git-branches-test-"));
  runGit(repository, ["init", "--initial-branch=main"]);
  runGit(repository, ["config", "user.email", "test@clero.local"]);
  runGit(repository, ["config", "user.name", "Clero Test"]);
  await writeFile(path.join(repository, "README.md"), "# Test\n");
  runGit(repository, ["add", "README.md"]);
  runGit(repository, ["commit", "-m", "Initial commit"]);
  runGit(repository, ["branch", "existing"]);

  const tools = new GitTools({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [repository] }),
    approvalProvider: new StaticApprovalProvider(true)
  });

  try {
    const listed = await tools.listBranches({ cwd: repository });
    assert.equal(listed.current_branch, "main");
    assert.deepEqual(
      Array.isArray(listed.branches)
        ? listed.branches.map((branch) => (
          branch && typeof branch === "object" && !Array.isArray(branch)
            ? branch.name
            : null
        ))
        : [],
      ["existing", "main"]
    );

    await tools.checkout({ cwd: repository, branch: "existing" });
    assert.equal(runGit(repository, ["branch", "--show-current"]).trim(), "existing");

    await tools.checkout({ cwd: repository, branch: "feature/new", create: true });
    assert.equal(runGit(repository, ["branch", "--show-current"]).trim(), "feature/new");
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
