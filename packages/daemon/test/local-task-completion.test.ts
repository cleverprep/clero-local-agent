import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { CodingTask, CodingTaskEvent } from "@clero-local-agent/coding-agents";
import type { RuntimeMessage } from "@clero-local-agent/protocol";
import { LocalRuntimeDaemon } from "../src/daemon.ts";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

const auditLogger = {
  record() {}
};

test("retries local coding task completion when backend has not recorded the task yet", async () => {
  const sentMessages: RuntimeMessage[] = [];
  const daemon = new LocalRuntimeDaemon({
    wsUrl: "ws://localhost/ws/local-runtime/",
    token: "token",
    allowedDirectories: [process.cwd()],
    capabilities: {
      browser: { enabled: false },
      workspace: { enabled: false },
      codex: { enabled: false },
      git: { readEnabled: false, writeEnabled: false }
    },
    logger,
    auditLogger
  });
  const daemonInternals = daemon as unknown as {
    websocket: { send(message: RuntimeMessage): void };
    sendCodingTaskCompletion(task: CodingTask): void;
    handleMessage(message: unknown): Promise<void>;
    clearPendingLocalTaskCompletions(): void;
  };
  daemonInternals.websocket.send = (message: RuntimeMessage) => {
    sentMessages.push(message);
  };

  daemonInternals.sendCodingTaskCompletion({
    task_id: "antigravity_1",
    request_id: "req_1",
    provider: "antigravity",
    status: "failed",
    cwd: process.cwd(),
    sandbox: "read-only",
    approval_required: false,
    approved: null,
    output: "script: tcgetattr/ioctl: Operation not supported on socket\n",
    agent_output: "",
    stdout: "",
    stderr: "script: tcgetattr/ioctl: Operation not supported on socket\n",
    final_message: null,
    exit_code: 1,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    events_count: 2,
    last_event_type: "process.closed",
    provider_session_id: "conversation_1",
    antigravity_conversation_id: "conversation_1",
    agent_id: "15",
    local_task_id: "223",
    event_run_id: "223"
  });

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]?.type, "local_task_completed");
  if (sentMessages[0]?.type !== "local_task_completed") {
    throw new Error("Expected local_task_completed");
  }
  assert.equal(sentMessages[0].event_run_id, "223");
  assert.equal(sentMessages[0].result.provider_session_id, "conversation_1");
  assert.equal(
    sentMessages[0].result.antigravity_conversation_id,
    "conversation_1"
  );

  await daemonInternals.handleMessage({
    type: "error",
    error_code: "not_found",
    message: "Local runtime task was not found.",
    task_id: "antigravity_1"
  });
  await delay(1_100);

  assert.equal(sentMessages.length, 2);
  const retriedMessage = sentMessages[1];
  assert.ok(retriedMessage);
  assert.equal(retriedMessage.type, "local_task_completed");
  if (retriedMessage.type !== "local_task_completed") {
    throw new Error("Expected local_task_completed retry");
  }
  assert.equal(retriedMessage.task_id, "antigravity_1");
  assert.equal(retriedMessage.event_run_id, "223");

  daemonInternals.clearPendingLocalTaskCompletions();
});

test("streams normalized coding task events over the runtime websocket", () => {
  const sentMessages: RuntimeMessage[] = [];
  const daemon = new LocalRuntimeDaemon({
    wsUrl: "ws://localhost/ws/local-runtime/",
    token: "token",
    allowedDirectories: [process.cwd()],
    capabilities: {
      browser: { enabled: false },
      workspace: { enabled: false },
      codex: { enabled: false },
      git: { readEnabled: false, writeEnabled: false }
    },
    logger,
    auditLogger
  });
  const daemonInternals = daemon as unknown as {
    websocket: { send(message: RuntimeMessage): void };
    sendCodingTaskEvent(
      task: CodingTask,
      event: CodingTaskEvent,
      text: string
    ): void;
  };
  daemonInternals.websocket.send = (message: RuntimeMessage) => {
    sentMessages.push(message);
  };

  daemonInternals.sendCodingTaskEvent(
    {
      task_id: "codex_live_1",
      request_id: "req_live_1",
      provider: "codex",
      status: "running",
      cwd: "/srv/apps/clero",
      git_branch: "test-deploy",
      sandbox: "workspace-write",
      model: "gpt-5.3-codex",
      approval_required: false,
      approved: true,
      output: "",
      agent_output: "",
      progress_update: "Running the focused tests.",
      stdout: "",
      stderr: "",
      final_message: null,
      exit_code: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      codex_thread_id: "thread_live_1",
      provider_session_id: "thread_live_1",
      events_count: 3,
      last_event_type: "item.started",
      agent_id: "50",
      local_task_id: "1350",
      event_run_id: "16927"
    },
    {
      index: 3,
      at: "2026-07-26T12:00:00.000Z",
      source: "codex",
      type: "item.started",
      actions: [{
        id: "command_1",
        phase: "started",
        kind: "command",
        name: "command_execution",
        detail: "pnpm test"
      }]
    },
    "pnpm test"
  );

  assert.equal(sentMessages.length, 1);
  const message = sentMessages[0];
  assert.ok(message && message.type === "local_task_event");
  assert.equal(message.task_id, "codex_live_1");
  assert.equal(message.event_run_id, "16927");
  assert.equal(message.task.git_branch, "test-deploy");
  assert.equal(message.task.codex_thread_id, "thread_live_1");
  assert.equal(message.event.item_type, "command");
  assert.equal(message.event.text, "pnpm test");
  assert.deepEqual(message.event.actions, [{
    id: "command_1",
    phase: "started",
    kind: "command",
    name: "command_execution",
    detail: "pnpm test"
  }]);
});

test("applies remote coding-agent configuration and republishes capabilities", async () => {
  const sentMessages: RuntimeMessage[] = [];
  let savedConfig = {
    enabled: false,
    provider: "codex",
    default_sandbox: "read-only",
    allow_workspace_write: false,
    allow_danger_full_access: false
  };
  const daemon = new LocalRuntimeDaemon({
    wsUrl: "ws://localhost/ws/local-runtime/",
    token: "token",
    allowedDirectories: [process.cwd()],
    capabilities: {
      browser: { enabled: false },
      workspace: { enabled: false },
      codex: { enabled: false },
      git: { readEnabled: false, writeEnabled: false }
    },
    codingAgentConfiguration: {
      get: () => savedConfig,
      set: (config) => {
        savedConfig = {
          ...savedConfig,
          ...config,
          enabled: config.enabled !== false,
          provider: config.provider === "cursor" ? "cursor" : "codex",
          default_sandbox: config.default_sandbox === "workspace-write" ? "workspace-write" : "read-only",
          allow_workspace_write: config.allow_workspace_write === true,
          allow_danger_full_access: config.allow_danger_full_access === true
        };
        return Promise.resolve(savedConfig);
      }
    },
    logger,
    auditLogger
  });
  const daemonInternals = daemon as unknown as {
    websocket: { send(message: RuntimeMessage): void };
    handleMessage(message: unknown): Promise<void>;
  };
  daemonInternals.websocket.send = (message: RuntimeMessage) => {
    sentMessages.push(message);
  };

  await daemonInternals.handleMessage({
    type: "control_request",
    request_id: "control_1",
    action: "set_coding_agent_config",
    arguments: {
      enabled: true,
      provider: "cursor",
      default_sandbox: "workspace-write",
      allow_workspace_write: true
    }
  });

  const heartbeat = sentMessages.find((message) => message.type === "heartbeat");
  const result = sentMessages.find((message) => (
    message.type === "control_result" && message.request_id === "control_1"
  ));
  assert.ok(heartbeat && heartbeat.type === "heartbeat");
  assert.ok(result && result.type === "control_result");
  assert.equal(result.status, "ok");
  assert.equal(
    heartbeat.capabilities?.tools.some((capability) => capability.name === "coding_agent.start_task"),
    true
  );
  assert.equal(heartbeat.capabilities?.settings?.coding_agent?.provider, "cursor");
});
