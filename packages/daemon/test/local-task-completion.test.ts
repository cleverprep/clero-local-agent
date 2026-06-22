import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { CodingTask } from "@clero-local-agent/coding-agents";
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
