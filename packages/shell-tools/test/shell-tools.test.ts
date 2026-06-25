import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StaticApprovalProvider } from "@clero-local-agent/approvals";
import { ToolExecutionError } from "@clero-local-agent/mcp-runtime";
import { WorkspacePolicy } from "@clero-local-agent/workspace";
import { ShellTools } from "../src/index.ts";

test("runs an inspection shell command in an allowed workspace", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "clero-shell-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const tools = new ShellTools({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [workspace] }),
    shell: "/bin/sh"
  });

  const result = await tools.run({ command: "pwd", cwd: workspace }, { requestId: "req_1" });

  assert.equal(result.exit_code, 0);
  assert.equal(result.access, "read-only");
  assert.equal(result.approval_required, false);
  assert.match(String(result.stdout), new RegExp(workspace));
});

test("blocks common write commands in inspection-only shell", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "clero-shell-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const tools = new ShellTools({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [workspace] }),
    shell: "/bin/sh"
  });

  await assert.rejects(
    () => tools.run({ command: "touch created.txt", cwd: workspace }, { requestId: "req_1" }),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.errorCode === "approval_denied" &&
      error.message.includes("Inspection-only shell blocks")
  );
});

test("runs workspace-write shell command when locally enabled", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "clero-shell-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const tools = new ShellTools({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [workspace] }),
    approvalProvider: new StaticApprovalProvider(false, "not approved"),
    allowWorkspaceWrite: true,
    shell: "/bin/sh"
  });
  const node = JSON.stringify(process.execPath);

  const result = await tools.run(
    {
      command: `${node} -e "require('fs').writeFileSync('created.txt', 'ok')"`,
      cwd: workspace,
      access: "workspace-write"
    },
    { requestId: "req_1" }
  );

  assert.equal(result.exit_code, 0);
  assert.equal(result.approved, true);
  assert.equal(await readFile(path.join(workspace, "created.txt"), "utf8"), "ok");
});

test("times out long-running shell commands", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "clero-shell-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const tools = new ShellTools({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [workspace] }),
    shell: "/bin/sh",
    defaultTimeoutMs: 1_000
  });
  const node = JSON.stringify(process.execPath);

  const result = await tools.run(
    {
      command: `${node} -e "setTimeout(() => {}, 10000)"`,
      cwd: workspace
    },
    { requestId: "req_1" }
  );

  assert.equal(result.timed_out, true);
  assert.equal(result.exit_code, 124);
});
