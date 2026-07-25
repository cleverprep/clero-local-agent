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

test("git tools report pull conflicts and abort rebase or merge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-git-pull-test-"));
  const remote = path.join(root, "remote.git");
  const repository = path.join(root, "repository");
  const peer = path.join(root, "peer");

  runGit(root, ["init", "--bare", "--initial-branch=main", remote]);
  runGit(root, ["clone", remote, repository]);
  configureGitUser(repository);
  await writeFile(path.join(repository, "shared.txt"), "base\n");
  runGit(repository, ["add", "shared.txt"]);
  runGit(repository, ["commit", "-m", "Initial commit"]);
  runGit(repository, ["push", "--set-upstream", "origin", "main"]);

  runGit(root, ["clone", remote, peer]);
  configureGitUser(peer);
  await writeFile(path.join(repository, "shared.txt"), "local\n");
  runGit(repository, ["commit", "-am", "Local change"]);
  await writeFile(path.join(peer, "shared.txt"), "remote\n");
  runGit(peer, ["commit", "-am", "Remote change"]);
  runGit(peer, ["push"]);

  const tools = new GitTools({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [repository] }),
    approvalProvider: new StaticApprovalProvider(true)
  });

  try {
    const rebase = await tools.pull({ cwd: repository, strategy: "rebase" });
    assert.equal(rebase.conflicted, true);
    assert.equal(rebase.operation, "rebase");
    assert.deepEqual(rebase.conflict_paths, ["shared.txt"]);

    const rebaseStatus = await tools.status({ cwd: repository });
    assert.equal(rebaseStatus.operation, "rebase");
    assert.equal(
      (rebaseStatus.files as Record<string, unknown>).conflicted,
      1
    );

    await tools.abortPull({ cwd: repository });
    const afterRebaseAbort = await tools.status({ cwd: repository });
    assert.equal(afterRebaseAbort.operation, null);
    assert.equal(afterRebaseAbort.clean, true);

    const merge = await tools.pull({ cwd: repository, strategy: "merge" });
    assert.equal(merge.conflicted, true);
    assert.equal(merge.operation, "merge");
    assert.deepEqual(merge.conflict_paths, ["shared.txt"]);

    await tools.abortPull({ cwd: repository });
    const afterMergeAbort = await tools.status({ cwd: repository });
    assert.equal(afterMergeAbort.operation, null);
    assert.equal(afterMergeAbort.clean, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function configureGitUser(repository: string): void {
  runGit(repository, ["config", "user.email", "test@clero.local"]);
  runGit(repository, ["config", "user.name", "Clero Test"]);
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
