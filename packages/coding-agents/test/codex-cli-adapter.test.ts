import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { StaticApprovalProvider } from "@clero-local-agent/approvals";
import { ToolExecutionError } from "@clero-local-agent/mcp-runtime";
import type { JsonObject, JsonValue } from "@clero-local-agent/protocol";
import { WorkspacePolicy } from "@clero-local-agent/workspace";
import { AntigravityCliAdapter, ClaudeCodeAdapter, CodexCliAdapter, type CodingAgentAdapter } from "../src/index.ts";

test("runs codex exec as an async JSONL task", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "clero-codex-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const fakeCodex = await createFakeCodex(workspace, 0);
  const terminalTasks: Array<{ agent_id?: string; event_run_id?: string }> = [];
  const streamedEvents: string[] = [];
  const adapter = new CodexCliAdapter({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [workspace] }),
    command: fakeCodex,
    defaultModel: "gpt-5.3-codex",
    defaultReasoningEffort: "high",
    onTaskEvent: (_task, event) => {
      streamedEvents.push(event.type);
    },
    onTaskTerminal: (task) => {
      terminalTasks.push(task);
    }
  });

  const start = await adapter.startTask(
    { prompt: "inspect repo" },
    {
      requestId: "req_1",
      leaseId: "lease_1",
      agentId: "agent_1",
      taskId: "task_1",
      eventRunId: "201"
    }
  );

  assert.equal(start.status, "running");
  assert.equal(start.sandbox, "read-only");
  const taskId = stringField(start, "task_id");
  const status = await waitForTerminalStatus(adapter, taskId);

  assert.equal(status.status, "completed");
  assert.equal(status.exit_code, 0);
  assert.equal(status.final_message, "done: inspect repo");
  assert.equal(terminalTasks[0]?.agent_id, "agent_1");
  assert.equal(terminalTasks[0]?.event_run_id, "201");
  assert.equal(streamedEvents.includes("item.completed"), true);

  const output = await adapter.getOutput(taskId);
  assert.equal(output.final_message, "done: inspect repo");
  assert.match(stringField(output, "stderr"), /fake stderr/);

  const events = eventArray(output.events);
  assert.equal(events.some((event) => event.type === "thread.started"), true);
  assert.equal(events.some((event) => event.type === "item.completed"), true);

  const processStarted = events.find((event) => event.type === "process.started");
  assert.ok(processStarted);
  const processData = objectField(processStarted, "data");
  const args = stringArrayField(processData, "args");
  assert.deepEqual(args.slice(0, 8), ["--ask-for-approval", "never", "exec", "--json", "--sandbox", "read-only", "--cd", workspace]);
  assert.deepEqual(args.slice(8, 12), ["--model", "gpt-5.3-codex", "--config", 'model_reasoning_effort="high"']);
  assert.equal(args.at(-1), "-");
});

test("requires approval before starting a writable codex exec task", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "clero-codex-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const adapter = new CodexCliAdapter({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [workspace] }),
    approvalProvider: new StaticApprovalProvider(false, "not approved"),
    command: path.join(workspace, "should-not-run")
  });

  await assert.rejects(
    () =>
      adapter.startTask(
        { prompt: "edit files", cwd: workspace, sandbox: "workspace-write" },
        { requestId: "req_1", leaseId: "lease_1", agentId: "agent_1", taskId: "task_1" }
      ),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.errorCode === "approval_denied" &&
      error.message.includes("not approved")
  );
});

test("uses local workspace-write setting as Codex sandbox approval", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "clero-codex-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const fakeCodex = await createFakeCodex(workspace, 0);
  const adapter = new CodexCliAdapter({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [workspace] }),
    approvalProvider: new StaticApprovalProvider(false, "not approved"),
    command: fakeCodex,
    allowWorkspaceWrite: true
  });

  const start = await adapter.startTask(
    { prompt: "edit files", cwd: workspace, sandbox: "workspace-write" },
    { requestId: "req_1", leaseId: "lease_1", agentId: "agent_1", taskId: "task_1" }
  );

  assert.equal(start.status, "running");
  assert.equal(start.approved, true);
  assert.equal(start.approval_reason, "Approved by local workspace-write setting");
  const status = await waitForTerminalStatus(adapter, stringField(start, "task_id"));
  assert.equal(status.status, "completed");
});

test("rejects a missing coding-agent working directory before spawning", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "clero-coding-cwd-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const adapter = new ClaudeCodeAdapter({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [workspace] }),
    command: path.join(workspace, "should-not-run")
  });

  await assert.rejects(
    () =>
      adapter.startTask(
        { prompt: "inspect repo", cwd: path.join(workspace, "missing") },
        { requestId: "req_1", leaseId: "lease_1", agentId: "agent_1", taskId: "task_1" }
      ),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.errorCode === "invalid_arguments" &&
      error.message.includes("cwd does not exist")
  );
});

test("marks nonzero approval or sandbox exits as blocked", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "clero-codex-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const fakeCodex = await createFakeCodex(workspace, 2, "sandbox prevented this command");
  const adapter = new CodexCliAdapter({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [workspace] }),
    command: fakeCodex
  });

  const start = await adapter.startTask(
    { prompt: "try blocked command", cwd: workspace },
    { requestId: "req_1", leaseId: "lease_1", agentId: "agent_1", taskId: "task_1" }
  );

  const status = await waitForTerminalStatus(adapter, stringField(start, "task_id"));

  assert.equal(status.status, "blocked");
  assert.match(stringField(status, "blocked_reason"), /sandbox/i);
});

test("runs claude code print mode as an async JSONL task", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "clero-claude-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const fakeClaude = await createFakeClaude(workspace, 0);
  const adapter = new ClaudeCodeAdapter({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [workspace] }),
    command: fakeClaude,
    defaultModel: "claude-sonnet-4-5",
    defaultReasoningEffort: "high",
    permissionMode: "plan"
  });

  const start = await adapter.startTask(
    { prompt: "inspect repo", cwd: workspace },
    { requestId: "req_1", leaseId: "lease_1", agentId: "agent_1", taskId: "task_1" }
  );

  assert.equal(start.provider, "claude-code");
  assert.equal(start.permission_mode, "plan");
  const status = await waitForTerminalStatus(adapter, stringField(start, "task_id"));

  assert.equal(status.status, "completed");
  assert.equal(status.final_message, "done: inspect repo");

  const output = await adapter.getOutput(stringField(start, "task_id"));
  const events = eventArray(output.events);
  const processStarted = events.find((event) => event.type === "process.started");
  assert.ok(processStarted);
  const processData = objectField(processStarted, "data");
  const args = stringArrayField(processData, "args");
  assert.deepEqual(args.slice(0, 8), [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "plan",
    "--model",
    "claude-sonnet-4-5"
  ]);
  assert.deepEqual(args.slice(8, 10), ["--effort", "high"]);
  assert.equal(args.at(-1), "<prompt>");
});

test("runs antigravity cli as an async text task", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "clero-antigravity-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const fakeAntigravity = await createFakeAntigravity(workspace, 0);
  const adapter = new AntigravityCliAdapter({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [workspace] }),
    approvalProvider: new StaticApprovalProvider(false, "not approved"),
    command: fakeAntigravity,
    allowWorkspaceWrite: true
  });

  const start = await adapter.startTask(
    { prompt: "inspect repo", cwd: workspace, sandbox: "workspace-write" },
    { requestId: "req_1", leaseId: "lease_1", agentId: "agent_1", taskId: "task_1" }
  );

  assert.equal(start.provider, "antigravity");
  assert.equal(start.sandbox, "workspace-write");
  assert.equal(start.approved, true);

  const status = await waitForTerminalStatus(adapter, stringField(start, "task_id"));
  assert.equal(status.status, "completed");
  assert.equal(status.final_message, "done: inspect repo");

  const output = await adapter.getOutput(stringField(start, "task_id"));
  assert.match(stringField(output, "stdout"), /done: inspect repo/);

  const events = eventArray(output.events);
  const processStarted = events.find((event) => event.type === "process.started");
  assert.ok(processStarted);
  const processData = objectField(processStarted, "data");
  const args = stringArrayField(processData, "args");
  assert.deepEqual(args, ["--sandbox"]);
});

async function createFakeCodex(workspace: string, exitCode: number, errorMessage?: string): Promise<string> {
  const fakeCodex = path.join(workspace, `fake-codex-${exitCode}.js`);
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  console.error(${JSON.stringify(errorMessage ?? "fake stderr")});
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread_fake" }));
  console.log(JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "done: " + prompt.trim() } }));
  console.log(JSON.stringify({ type: ${JSON.stringify(errorMessage ? "error" : "turn.completed")}, message: ${JSON.stringify(errorMessage ?? "ok")} }));
  process.exit(${exitCode});
});
`
  );
  await chmod(fakeCodex, 0o755);
  return fakeCodex;
}

async function createFakeAntigravity(workspace: string, exitCode: number): Promise<string> {
  const fakeAntigravity = path.join(workspace, `fake-antigravity-${exitCode}.js`);
  await writeFile(
    fakeAntigravity,
    `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  console.log("done: " + prompt.trim());
  process.exit(${exitCode});
});
`
  );
  await chmod(fakeAntigravity, 0o755);
  return fakeAntigravity;
}

async function createFakeClaude(workspace: string, exitCode: number): Promise<string> {
  const fakeClaude = path.join(workspace, `fake-claude-${exitCode}.js`);
  await writeFile(
    fakeClaude,
    `#!/usr/bin/env node
const prompt = process.argv.at(-1) || "";
console.log(JSON.stringify({ type: "system", subtype: "init" }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done: " + prompt.trim() }] } }));
console.log(JSON.stringify({ type: "result", result: "done: " + prompt.trim() }));
process.exit(${exitCode});
`
  );
  await chmod(fakeClaude, 0o755);
  return fakeClaude;
}

async function waitForTerminalStatus(adapter: CodingAgentAdapter, taskId: string): Promise<JsonObject> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await adapter.getStatus(taskId);
    if (status.status !== "running") {
      return status;
    }
    await delay(20);
  }

  throw new Error("Timed out waiting for Codex task to finish");
}

function stringField(object: JsonObject, key: string): string {
  const value = object[key];
  assert.equal(typeof value, "string");
  return value as string;
}

function objectField(object: JsonObject, key: string): JsonObject {
  const value = object[key];
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as JsonObject;
}

function stringArrayField(object: JsonObject, key: string): string[] {
  const value = object[key];
  assert.equal(Array.isArray(value), true);
  return (value as JsonValue[]).map((item) => {
    assert.equal(typeof item, "string");
    return item as string;
  });
}

function eventArray(value: JsonValue | undefined): JsonObject[] {
  assert.equal(Array.isArray(value), true);
  return (value as JsonValue[]).map((event) => objectFromJsonValue(event));
}

function objectFromJsonValue(value: JsonValue): JsonObject {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as JsonObject;
}
