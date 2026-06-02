import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
  const resolvedWorkspace = await realpath(workspace);
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
  assert.match(stringField(output, "output"), /done: inspect repo/);
  assert.match(stringField(output, "message"), /done: inspect repo/);
  assert.doesNotMatch(stringField(output, "output"), /edited README/);
  assert.equal("events" in output, false);
  assert.equal("stderr" in output, false);
  assert.equal("raw_output" in output, false);

  const debugOutput = await adapter.getOutput(taskId, { include_events: true, include_raw: true });
  assert.match(stringField(debugOutput, "stderr"), /fake stderr/);
  assert.match(stringField(debugOutput, "raw_output"), /edited README/);

  const events = eventArray(debugOutput.events);
  assert.equal(events.some((event) => event.type === "thread.started"), true);
  assert.equal(events.some((event) => event.type === "item.completed"), true);

  const processStarted = events.find((event) => event.type === "process.started");
  assert.ok(processStarted);
  const processData = objectField(processStarted, "data");
  const args = stringArrayField(processData, "args");
  assert.deepEqual(args.slice(0, 8), ["--ask-for-approval", "never", "exec", "--json", "--sandbox", "read-only", "--cd", resolvedWorkspace]);
  assert.deepEqual(args.slice(8, 12), ["--model", "gpt-5.3-codex", "--config", 'model_reasoning_effort="high"']);
  assert.equal(args.at(-1), "-");
});

test("resumes codex exec when continue_session uses the same session key", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "clero-codex-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const resolvedWorkspace = await realpath(workspace);
  const fakeCodex = await createFakeCodex(workspace, 0);
  const adapter = new CodexCliAdapter({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [workspace] }),
    command: fakeCodex
  });

  const sessionKey = "agent_1:repo";
  const first = await adapter.startTask(
    { prompt: "first turn", cwd: workspace, continue_session: true, session_key: sessionKey },
    { requestId: "req_1", leaseId: "lease_1", agentId: "agent_1", taskId: "task_1" }
  );
  assert.equal(first.continue_session, true);
  assert.equal(first.resumed_session, false);
  assert.equal(first.session_key, sessionKey);

  const firstStatus = await waitForTerminalStatus(adapter, stringField(first, "task_id"));
  assert.equal(firstStatus.provider_session_id, "thread_fake");
  assert.equal(firstStatus.codex_thread_id, "thread_fake");

  const second = await adapter.startTask(
    { prompt: "second turn", cwd: workspace, continue_session: true, session_key: sessionKey },
    { requestId: "req_2", leaseId: "lease_1", agentId: "agent_1", taskId: "task_2" }
  );
  assert.equal(second.continue_session, true);
  assert.equal(second.resumed_session, true);
  assert.equal(second.provider_session_id, "thread_fake");
  assert.equal(second.codex_thread_id, "thread_fake");

  const secondStatus = await waitForTerminalStatus(adapter, stringField(second, "task_id"));
  assert.equal(secondStatus.status, "completed");

  const output = await adapter.getOutput(stringField(second, "task_id"), { include_events: true });
  const events = eventArray(output.events);
  const processStarted = events.find((event) => event.type === "process.started");
  assert.ok(processStarted);
  const processData = objectField(processStarted, "data");
  const args = stringArrayField(processData, "args");
  assert.deepEqual(args, [
    "--ask-for-approval",
    "never",
    "--sandbox",
    "read-only",
    "--cd",
    resolvedWorkspace,
    "exec",
    "resume",
    "--json",
    "thread_fake",
    "-"
  ]);
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

test("marks Codex Linux bubblewrap failures reported in final text as blocked", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "clero-codex-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const fakeCodex = await createFakeCodexBwrapFailure(workspace);
  const adapter = new CodexCliAdapter({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [workspace] }),
    command: fakeCodex
  });

  const start = await adapter.startTask(
    { prompt: "list files", cwd: workspace },
    { requestId: "req_1", leaseId: "lease_1", agentId: "agent_1", taskId: "task_1" }
  );

  const status = await waitForTerminalStatus(adapter, stringField(start, "task_id"));

  assert.equal(status.status, "blocked");
  assert.match(stringField(status, "blocked_reason"), /Codex Linux sandbox could not start/);
});

test("does not mark normal sandbox wording in Codex final text as blocked", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "clero-codex-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const message =
    "The test suite starts, but it cannot reach the configured PostgreSQL host db from this sandbox.";
  const fakeCodex = await createFakeCodexFinalMessage(workspace, message);
  const adapter = new CodexCliAdapter({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [workspace] }),
    command: fakeCodex,
    allowWorkspaceWrite: true
  });

  const start = await adapter.startTask(
    { prompt: "run tests", cwd: workspace, sandbox: "workspace-write" },
    { requestId: "req_1", leaseId: "lease_1", agentId: "agent_1", taskId: "task_1" }
  );

  const status = await waitForTerminalStatus(adapter, stringField(start, "task_id"));

  assert.equal(status.status, "completed");
  assert.equal(status.blocked_reason, undefined);

  const output = await adapter.getOutput(stringField(start, "task_id"));
  assert.match(stringField(output, "output"), /PostgreSQL host db/);
});

test("marks policy-blocked codex tasks terminal even when the process keeps running", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "clero-codex-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const fakeCodex = await createFakeHangingBlockedCodex(workspace);
  const terminalTasks: unknown[] = [];
  const adapter = new CodexCliAdapter({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [workspace] }),
    command: fakeCodex,
    onTaskTerminal: (task) => {
      terminalTasks.push(task);
    }
  });

  const start = await adapter.startTask(
    { prompt: "try blocked local command", cwd: workspace },
    { requestId: "req_1", leaseId: "lease_1", agentId: "agent_1", taskId: "task_1" }
  );

  const taskId = stringField(start, "task_id");
  const status = await waitForTerminalStatus(adapter, taskId);

  assert.equal(status.status, "blocked");
  assert.match(stringField(status, "blocked_reason"), /blocked by policy/i);
  assert.equal(terminalTasks.length, 1);

  const output = await adapter.getOutput(taskId, { include_events: true });
  const events = eventArray(output.events);
  assert.equal(events.some((event) => event.type === "process.blocked"), true);
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

  const output = await adapter.getOutput(stringField(start, "task_id"), { include_events: true });
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
  assert.equal(args.includes("-"), false);
  assert.equal(args.includes("<prompt>"), false);
});

test("uses local workspace-write setting as Claude acceptEdits approval", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "clero-claude-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const fakeClaude = await createFakeClaude(workspace, 0);
  const adapter = new ClaudeCodeAdapter({
    workspacePolicy: new WorkspacePolicy({ allowedDirectories: [workspace] }),
    approvalProvider: new StaticApprovalProvider(false, "not approved"),
    command: fakeClaude,
    permissionMode: "acceptEdits",
    allowWorkspaceWrite: true
  });

  const start = await adapter.startTask(
    { prompt: "edit files", cwd: workspace },
    { requestId: "req_1", leaseId: "lease_1", agentId: "agent_1", taskId: "task_1" }
  );

  assert.equal(start.status, "running");
  assert.equal(start.permission_mode, "acceptEdits");
  assert.equal(start.approved, true);
  assert.equal(start.approval_reason, "Approved by local workspace-write setting");

  const status = await waitForTerminalStatus(adapter, stringField(start, "task_id"));
  assert.equal(status.status, "completed");
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
  assert.match(stringField(output, "output"), /done: inspect repo/);
  assert.equal("stdout" in output, false);
  assert.equal("events" in output, false);

  const debugOutput = await adapter.getOutput(stringField(start, "task_id"), { include_events: true, include_raw: true });
  assert.match(stringField(debugOutput, "stdout"), /done: inspect repo/);
  const events = eventArray(debugOutput.events);
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
  console.log(JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "command_execution", output: "edited README.md\\nM README.md\\n" } }));
  console.log(JSON.stringify({ type: ${JSON.stringify(errorMessage ? "error" : "turn.completed")}, message: ${JSON.stringify(errorMessage ?? "ok")} }));
  process.exit(${exitCode});
});
`
  );
  await chmod(fakeCodex, 0o755);
  return fakeCodex;
}

async function createFakeHangingBlockedCodex(workspace: string): Promise<string> {
  const fakeCodex = path.join(workspace, "fake-codex-blocked-hanging.js");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  console.error("exec_command failed: Rejected: blocked by policy");
  setInterval(() => {}, 1000);
});
`
  );
  await chmod(fakeCodex, 0o755);
  return fakeCodex;
}

async function createFakeCodexBwrapFailure(workspace: string): Promise<string> {
  const fakeCodex = path.join(workspace, "fake-codex-bwrap.js");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread_fake" }));
  console.log(JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "The command could not run because the sandbox wrapper failed before execution:\\n\\nbwrap: loopback: Failed RTM_NEWADDR: Operation not permitted" } }));
  console.log(JSON.stringify({ type: "turn.completed" }));
  process.exit(0);
});
`
  );
  await chmod(fakeCodex, 0o755);
  return fakeCodex;
}

async function createFakeCodexFinalMessage(workspace: string, message: string): Promise<string> {
  const fakeCodex = path.join(workspace, "fake-codex-final-message.js");
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread_fake" }));
  console.log(JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: ${JSON.stringify(message)} } }));
  console.log(JSON.stringify({ type: "turn.completed" }));
  process.exit(0);
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
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done: " + prompt.trim() }] } }));
  console.log(JSON.stringify({ type: "result", result: "done: " + prompt.trim() }));
  process.exit(${exitCode});
});
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
