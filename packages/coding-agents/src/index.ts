import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApprovalProvider } from "@clero-local-agent/approvals";
import { ToolExecutionError, type ToolDefinition, type ToolExecutionContext } from "@clero-local-agent/mcp-runtime";
import { isJsonObject, type JsonObject, type JsonValue } from "@clero-local-agent/protocol";
import type { WorkspacePolicy } from "@clero-local-agent/workspace";

export type CodingTaskStatus = "running" | "completed" | "failed" | "blocked" | "cancelled";
export type CodingAgentProvider = "codex" | "claude-code" | "antigravity" | "cursor";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ClaudeCodePermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";
export type ClaudeCodeReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type CodingTaskActionKind = "command" | "file_change" | "read" | "search" | "plan" | "tool";
export type CodingTaskActionPhase = "started" | "completed";
export type CodingTaskAction = {
  id: string;
  phase: CodingTaskActionPhase;
  kind: CodingTaskActionKind;
  name: string;
  detail?: string;
  success?: boolean;
  error?: string;
};

export type CodingTaskEvent = {
  index: number;
  at: string;
  source: "codex" | "claude" | "antigravity" | "cursor" | "stdout" | "stderr" | "process";
  type: string;
  data?: JsonObject;
  text?: string;
  actions?: CodingTaskAction[];
};

export type CodingTask = {
  task_id: string;
  request_id: string;
  provider: CodingAgentProvider;
  status: CodingTaskStatus;
  cwd: string;
  git_branch?: string;
  sandbox: CodexSandbox;
  model?: string;
  reasoning_effort?: string;
  permission_mode?: string;
  approval_required: boolean;
  approved: boolean | null;
  approval_reason?: string;
  output: string;
  agent_output: string;
  progress_update?: string;
  stdout: string;
  stderr: string;
  final_message: string | null;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
  codex_thread_id?: string;
  events_count: number;
  last_event_type: string | null;
  blocked_reason?: string;
  lease_id?: string;
  agent_id?: string;
  local_task_id?: string;
  event_run_id?: string;
  session_key?: string;
  continue_session?: boolean;
  resumed_session?: boolean;
  provider_session_id?: string;
  claude_session_id?: string;
  antigravity_conversation_id?: string;
  antigravity_log_file?: string;
  antigravity_log_start_byte?: number;
  cursor_chat_id?: string;
};

export interface CodingAgentAdapter {
  startTask(args: JsonObject, context: ToolExecutionContext): Promise<JsonObject>;
  getStatus(taskId: string): Promise<JsonObject>;
  getOutput(taskId: string, args?: JsonObject): Promise<JsonObject>;
  cancel(taskId: string): Promise<JsonObject>;
}

export class CodingAgentTools {
  private readonly adapter: CodingAgentAdapter;

  constructor(adapter: CodingAgentAdapter) {
    this.adapter = adapter;
  }

  definitions(): ToolDefinition[] {
    return [
      {
        name: "coding_agent.start_task",
        description: "Start a non-interactive local Codex, Claude Code, Antigravity, or Cursor task in a discovered project. Prefer project over absolute cwd.",
        handler: (args, context) => this.adapter.startTask(args, context)
      },
      {
        name: "coding_agent.get_status",
        description: "Get local coding-agent task status.",
        handler: (args) => this.adapter.getStatus(requiredString(args, "task_id"))
      },
      {
        name: "coding_agent.get_output",
        description: "Get the local coding-agent message output. Raw events and streams are opt-in for diagnostics.",
        handler: (args) => this.adapter.getOutput(requiredString(args, "task_id"), args)
      },
      {
        name: "coding_agent.cancel",
        description: "Cancel a local coding-agent task.",
        handler: (args) => this.adapter.cancel(requiredString(args, "task_id"))
      }
    ];
  }
}

export type CodexCliAdapterOptions = {
  workspacePolicy: WorkspacePolicy;
  approvalProvider?: ApprovalProvider;
  command?: string;
  defaultModel?: string;
  defaultReasoningEffort?: CodexReasoningEffort;
  defaultSandbox?: CodexSandbox;
  allowWorkspaceWrite?: boolean;
  allowDangerFullAccess?: boolean;
  maxEvents?: number;
  maxOutputBytes?: number;
  onTaskHeartbeat?: (task: CodingTask) => void;
  onTaskEvent?: (task: CodingTask, event: CodingTaskEvent) => void;
  onTaskTerminal?: (task: CodingTask) => void;
};

export type ClaudeCodeAdapterOptions = {
  workspacePolicy: WorkspacePolicy;
  approvalProvider?: ApprovalProvider;
  command?: string;
  defaultModel?: string;
  defaultReasoningEffort?: ClaudeCodeReasoningEffort;
  permissionMode?: ClaudeCodePermissionMode;
  allowWorkspaceWrite?: boolean;
  allowBypassPermissions?: boolean;
  maxEvents?: number;
  maxOutputBytes?: number;
  onTaskHeartbeat?: (task: CodingTask) => void;
  onTaskEvent?: (task: CodingTask, event: CodingTaskEvent) => void;
  onTaskTerminal?: (task: CodingTask) => void;
};

export type AntigravityCliAdapterOptions = {
  workspacePolicy: WorkspacePolicy;
  approvalProvider?: ApprovalProvider;
  command?: string;
  defaultSandbox?: CodexSandbox;
  allowWorkspaceWrite?: boolean;
  allowDangerFullAccess?: boolean;
  maxEvents?: number;
  maxOutputBytes?: number;
  onTaskHeartbeat?: (task: CodingTask) => void;
  onTaskEvent?: (task: CodingTask, event: CodingTaskEvent) => void;
  onTaskTerminal?: (task: CodingTask) => void;
};

export type CursorCliAdapterOptions = {
  workspacePolicy: WorkspacePolicy;
  approvalProvider?: ApprovalProvider;
  command?: string;
  defaultModel?: string;
  defaultSandbox?: CodexSandbox;
  allowWorkspaceWrite?: boolean;
  allowDangerFullAccess?: boolean;
  maxEvents?: number;
  maxOutputBytes?: number;
  onTaskHeartbeat?: (task: CodingTask) => void;
  onTaskEvent?: (task: CodingTask, event: CodingTaskEvent) => void;
  onTaskTerminal?: (task: CodingTask) => void;
};

type StoredCodingTask = CodingTask & {
  process: ChildProcessWithoutNullStreams | null;
  events: CodingTaskEvent[];
  nextEventIndex: number;
  stdoutBuffer: string;
  leaseHeartbeatTimer: ReturnType<typeof setInterval> | null;
  actionState: Map<string, CodingTaskAction>;
  terminalCallbackCalled?: boolean;
};

type ApprovalMetadata = {
  required: boolean;
  approved: boolean | null;
  reason?: string;
};

type CodingSessionState = {
  providerSessionId: string;
  cwd: string;
  updatedAt: string;
};

type CodingSessionPlan = {
  key?: string;
  continueSession: boolean;
  providerSessionId?: string;
  resumed: boolean;
};

type CodingOutputOptions = {
  includeEvents: boolean;
  includeRaw: boolean;
  sinceEventIndex?: number;
  maxEvents?: number;
};

const SANDBOX_VALUES: CodexSandbox[] = ["read-only", "workspace-write", "danger-full-access"];
const REASONING_EFFORT_VALUES: CodexReasoningEffort[] = ["low", "medium", "high", "xhigh"];
const CLAUDE_PERMISSION_MODES: ClaudeCodePermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions"
];
const CLAUDE_REASONING_EFFORT_VALUES: ClaudeCodeReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_MAX_EVENTS = 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

export class CodexCliAdapter implements CodingAgentAdapter {
  private readonly command: string;
  private readonly tasks = new Map<string, StoredCodingTask>();
  private readonly sessions = new Map<string, CodingSessionState>();
  private readonly options: CodexCliAdapterOptions;
  private readonly maxEvents: number;
  private readonly maxOutputBytes: number;

  constructor(options: CodexCliAdapterOptions) {
    this.options = options;
    this.command = options.command ?? "codex";
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async startTask(args: JsonObject, context: ToolExecutionContext): Promise<JsonObject> {
    const prompt = requiredString(args, "prompt");
    const cwd = this.options.workspacePolicy.resolveProjectDirectory(optionalString(args, "project") ?? optionalString(args, "cwd"));
    await ensureExistingDirectory(cwd);
    const gitBranch = await gitBranchFromDirectory(cwd);
    const sandbox = effectiveSandbox(args, this.options.defaultSandbox);
    const approval = await this.ensureSandboxApproval(sandbox, cwd, prompt);
    const sessionPlan = codingSessionPlan(args, context, cwd, this.sessions);
    const taskId = `codex_${randomUUID()}`;
    const cliArgs = this.codexExecArgs(
      args,
      cwd,
      sandbox,
      sessionPlan,
      gitBranch === undefined
    );
    const child = spawn(this.command, cliArgs, {
      cwd,
      stdio: "pipe"
    });

    const task: StoredCodingTask = {
      task_id: taskId,
      request_id: context.requestId,
      provider: "codex",
      status: "running",
      cwd,
      git_branch: gitBranch,
      sandbox,
      model: optionalString(args, "model") ?? this.options.defaultModel,
      reasoning_effort: reasoningEffortArg(args, "reasoning_effort") ?? this.options.defaultReasoningEffort,
      approval_required: approval.required,
      approved: approval.approved,
      approval_reason: approval.reason,
      output: "",
      agent_output: "",
      stdout: "",
      stderr: "",
      final_message: null,
      exit_code: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      events_count: 0,
      last_event_type: null,
      lease_id: context.leaseId,
      agent_id: context.agentId,
      local_task_id: context.taskId,
      event_run_id: context.eventRunId,
      session_key: sessionPlan.key,
      continue_session: sessionPlan.continueSession,
      resumed_session: sessionPlan.resumed,
      provider_session_id: sessionPlan.providerSessionId,
      codex_thread_id: sessionPlan.providerSessionId,
      process: child,
      events: [],
      nextEventIndex: 0,
      stdoutBuffer: "",
      leaseHeartbeatTimer: null,
      actionState: new Map()
    };

    this.tasks.set(taskId, task);
    this.startLeaseHeartbeat(task);
    this.appendProcessEvent(task, "process.started", {
      command: this.command,
      args: cliArgs,
      cwd,
      sandbox
    });

    child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdoutChunk(task, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      task.stderr = appendBounded(task.stderr, text, this.maxOutputBytes);
      task.output = appendBounded(task.output, text, this.maxOutputBytes);
      this.appendTextEvent(task, "stderr", "stderr.chunk", text);
      this.markBlockedFromText(task, text);
    });
    child.on("error", (error) => {
      task.status = "failed";
      task.stderr = appendBounded(task.stderr, `${error.message}\n`, this.maxOutputBytes);
      task.output = appendBounded(task.output, `${error.message}\n`, this.maxOutputBytes);
      task.finished_at = new Date().toISOString();
      task.process = null;
      this.appendProcessEvent(task, "process.error", { message: error.message });
      this.notifyTerminal(task);
    });
    child.on("close", (code) => {
      this.flushStdoutBuffer(task);
      task.exit_code = code;
      if (task.status !== "cancelled") {
        task.status = this.statusFromExit(task, code);
      }
      task.finished_at = new Date().toISOString();
      task.process = null;
      this.appendProcessEvent(task, "process.closed", {
        exit_code: code,
        status: task.status
      });
      this.notifyTerminal(task);
    });

    child.stdin.end(prompt);
    return this.publicTask(task);
  }

  async getStatus(taskId: string): Promise<JsonObject> {
    return this.publicTask(this.requireTask(taskId));
  }

  async getOutput(taskId: string, args: JsonObject = {}): Promise<JsonObject> {
    const task = this.requireTask(taskId);
    const options = outputOptions(args);
    const result = codingTaskOutputResult(task, options);
    if (options.includeEvents) {
      result.events = this.selectEvents(task, options.sinceEventIndex, options.maxEvents) as unknown as JsonValue;
    }
    return result;
  }

  async cancel(taskId: string): Promise<JsonObject> {
    const task = this.requireTask(taskId);
    if (task.process && task.status === "running") {
      task.status = "cancelled";
      task.finished_at = new Date().toISOString();
      task.process.kill("SIGTERM");
      this.appendProcessEvent(task, "process.cancelled", { reason: "cancelled by tool call" });
      this.notifyTerminal(task);
    }

    return this.publicTask(task);
  }

  private codexExecArgs(
    args: JsonObject,
    cwd: string,
    sandbox: CodexSandbox,
    sessionPlan: CodingSessionPlan,
    workspaceNeedsGitCheckBypass: boolean
  ): string[] {
    if (sessionPlan.resumed && sessionPlan.providerSessionId) {
      const cliArgs = ["--ask-for-approval", "never", "--sandbox", sandbox, "--cd", cwd, "exec", "resume", "--json"];
      const model = optionalString(args, "model") ?? this.options.defaultModel;
      if (model) {
        cliArgs.push("--model", model);
      }
      const reasoningEffort = reasoningEffortArg(args, "reasoning_effort") ?? this.options.defaultReasoningEffort;
      if (reasoningEffort) {
        cliArgs.push("--config", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
      }
      if (booleanArg(args, "ephemeral")) {
        cliArgs.push("--ephemeral");
      }
      if (workspaceNeedsGitCheckBypass || booleanArg(args, "skip_git_repo_check")) {
        cliArgs.push("--skip-git-repo-check");
      }
      cliArgs.push(sessionPlan.providerSessionId, "-");
      return cliArgs;
    }

    const cliArgs = ["--ask-for-approval", "never", "exec", "--json", "--sandbox", sandbox, "--cd", cwd];
    const model = optionalString(args, "model") ?? this.options.defaultModel;
    if (model) {
      cliArgs.push("--model", model);
    }
    const reasoningEffort = reasoningEffortArg(args, "reasoning_effort") ?? this.options.defaultReasoningEffort;
    if (reasoningEffort) {
      cliArgs.push("--config", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
    }
    if (booleanArg(args, "ephemeral")) {
      cliArgs.push("--ephemeral");
    }
    if (workspaceNeedsGitCheckBypass || booleanArg(args, "skip_git_repo_check")) {
      cliArgs.push("--skip-git-repo-check");
    }
    cliArgs.push("-");
    return cliArgs;
  }

  private async ensureSandboxApproval(sandbox: CodexSandbox, cwd: string, prompt: string): Promise<ApprovalMetadata> {
    if (sandbox === "read-only") {
      return { required: false, approved: null, reason: "No approval required for read-only sandbox" };
    }

    if (sandbox === "workspace-write" && this.options.allowWorkspaceWrite === false) {
      throw new ToolExecutionError("approval_denied", "Codex workspace-write sandbox is disabled in local settings.", {
        sandbox,
        cwd
      });
    }
    if (sandbox === "workspace-write" && this.options.allowWorkspaceWrite === true) {
      return {
        required: true,
        approved: true,
        reason: "Approved by local workspace-write setting"
      };
    }

    if (sandbox === "danger-full-access" && this.options.allowDangerFullAccess !== true) {
      throw new ToolExecutionError("approval_denied", "Codex danger-full-access sandbox is disabled in local settings.", {
        sandbox,
        cwd
      });
    }
    if (sandbox === "danger-full-access" && this.options.allowDangerFullAccess === true) {
      return {
        required: true,
        approved: true,
        reason: "Approved by local full-access setting"
      };
    }

    if (!this.options.approvalProvider) {
      throw new ToolExecutionError(
        "approval_denied",
        `Approval is required to run Codex with ${sandbox} sandbox, but no approval provider is configured.`,
        { sandbox, cwd }
      );
    }

    const decision = await this.options.approvalProvider.requestApproval({
      tool: "coding_agent.start_task",
      summary: `Run Codex with ${sandbox} sandbox in ${cwd}`,
      metadata: {
        cwd,
        sandbox,
        prompt_preview: prompt.slice(0, 500)
      }
    });

    if (!decision.approved) {
      throw new ToolExecutionError(
        "approval_denied",
        `Approval denied for Codex ${sandbox} task: ${decision.reason ?? "No reason provided"}`,
        { sandbox, cwd, reason: decision.reason ?? null }
      );
    }

    return { required: true, approved: true, reason: decision.reason };
  }

  private handleStdoutChunk(task: StoredCodingTask, text: string): void {
    task.stdout = appendBounded(task.stdout, text, this.maxOutputBytes);
    task.stdoutBuffer += text;

    const lines = task.stdoutBuffer.split(/\r?\n/);
    task.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      this.handleStdoutLine(task, line);
    }
  }

  private flushStdoutBuffer(task: StoredCodingTask): void {
    if (!task.stdoutBuffer) {
      return;
    }
    this.handleStdoutLine(task, task.stdoutBuffer);
    task.stdoutBuffer = "";
  }

  private handleStdoutLine(task: StoredCodingTask, line: string): void {
    if (line.trim().length === 0) {
      return;
    }

    const event = parseJsonObject(line);
    if (!event) {
      task.output = appendBounded(task.output, `${line}\n`, this.maxOutputBytes);
      this.appendTextEvent(task, "stdout", "stdout.line", line);
      this.markBlockedFromText(task, line);
      return;
    }

    this.handleCodexEvent(task, event);
  }

  private handleCodexEvent(task: StoredCodingTask, event: JsonObject): void {
    const type = stringValue(event.type) ?? "codex.event";
    const actions = normalizeCodingTaskActions("codex", event, task.actionState);
    this.appendEvent(task, {
      at: new Date().toISOString(),
      source: "codex",
      type,
      data: event,
      ...(actions.length > 0 ? { actions } : {})
    });

    if (type === "thread.started" && typeof event.thread_id === "string") {
      task.codex_thread_id = event.thread_id;
      task.provider_session_id = event.thread_id;
      rememberCodingSession(this.sessions, task, event.thread_id);
    }

    if (type === "item.completed" && isJsonObject(event.item)) {
      this.handleCompletedItem(task, event.item);
    }

    const blockedReason = blockedReasonFromEvent(event);
    if (blockedReason) {
      this.markTaskBlocked(task, blockedReason);
    }
  }

  private handleCompletedItem(task: StoredCodingTask, item: JsonObject): void {
    if (item.type === "agent_message" && typeof item.text === "string") {
      task.final_message = item.text;
      task.output = appendBounded(task.output, `${item.text}\n`, this.maxOutputBytes);
      appendAgentOutput(task, item.text, this.maxOutputBytes);
      this.markBlockedFromText(task, item.text);
    }

    if (item.type === "command_execution" && typeof item.output === "string") {
      task.output = appendBounded(task.output, item.output, this.maxOutputBytes);
      this.markBlockedFromText(task, item.output);
    }
  }

  private statusFromExit(task: StoredCodingTask, code: number | null): CodingTaskStatus {
    if (task.blocked_reason || looksApprovalOrSandboxBlocked(task.output) || looksApprovalOrSandboxBlocked(task.stderr)) {
      task.blocked_reason ??= "Codex task stopped because approval, sandbox, or permission policy blocked progress.";
      return "blocked";
    }

    if (code === 0) {
      return "completed";
    }

    return "failed";
  }

  private markBlockedFromText(task: StoredCodingTask, text: string): void {
    const blockedReason = blockedReasonFromText(text);
    if (blockedReason) {
      this.markTaskBlocked(task, blockedReason);
    }
  }

  private markTaskBlocked(task: StoredCodingTask, reason: string): void {
    task.blocked_reason ??= reason;
    if (!task.output.includes(reason)) {
      task.output = appendBounded(task.output, `${reason}\n`, this.maxOutputBytes);
    }
    if (!task.agent_output.includes(reason)) {
      appendAgentOutput(task, reason, this.maxOutputBytes);
    }
    if (task.status !== "running") {
      return;
    }

    task.status = "blocked";
    task.finished_at = new Date().toISOString();
    this.appendProcessEvent(task, "process.blocked", { reason: task.blocked_reason });
    task.process?.kill("SIGTERM");
    this.notifyTerminal(task);
  }

  private appendProcessEvent(task: StoredCodingTask, type: string, data: JsonObject): void {
    this.appendEvent(task, {
      at: new Date().toISOString(),
      source: "process",
      type,
      data
    });
  }

  private appendTextEvent(task: StoredCodingTask, source: "stdout" | "stderr", type: string, text: string): void {
    this.appendEvent(task, {
      at: new Date().toISOString(),
      source,
      type,
      text
    });
  }

  private appendEvent(task: StoredCodingTask, event: Omit<CodingTaskEvent, "index">): void {
    const indexedEvent = {
      ...event,
      index: task.nextEventIndex++
    };
    task.events.push(indexedEvent);
    task.events_count = task.nextEventIndex;
    task.last_event_type = indexedEvent.type;
    this.options.onTaskEvent?.(task, indexedEvent);

    while (task.events.length > this.maxEvents) {
      task.events.shift();
    }
  }

  private selectEvents(task: StoredCodingTask, sinceEventIndex?: number, maxEvents?: number): CodingTaskEvent[] {
    const selected =
      sinceEventIndex === undefined ? task.events : task.events.filter((event) => event.index >= sinceEventIndex);
    const limit = maxEvents === undefined ? selected.length : Math.max(0, Math.floor(maxEvents));
    return selected.slice(0, limit);
  }

  private requireTask(taskId: string): StoredCodingTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown coding task: ${taskId}`);
    }

    return task;
  }

  private publicTask(task: CodingTask): JsonObject {
    return publicTask(task);
  }

  private notifyTerminal(task: StoredCodingTask): void {
    if (task.terminalCallbackCalled) {
      return;
    }

    task.terminalCallbackCalled = true;
    this.stopLeaseHeartbeat(task);
    this.options.onTaskTerminal?.(task);
  }

  private startLeaseHeartbeat(task: StoredCodingTask): void {
    if (!task.lease_id || !this.options.onTaskHeartbeat) {
      return;
    }

    task.leaseHeartbeatTimer = setInterval(() => {
      this.options.onTaskHeartbeat?.(task);
    }, 30_000);
    task.leaseHeartbeatTimer.unref?.();
  }

  private stopLeaseHeartbeat(task: StoredCodingTask): void {
    if (!task.leaseHeartbeatTimer) {
      return;
    }

    clearInterval(task.leaseHeartbeatTimer);
    task.leaseHeartbeatTimer = null;
  }
}

export class AntigravityCliAdapter implements CodingAgentAdapter {
  private readonly command: string;
  private readonly tasks = new Map<string, StoredCodingTask>();
  private readonly sessions = new Map<string, CodingSessionState>();
  private readonly options: AntigravityCliAdapterOptions;
  private readonly maxEvents: number;
  private readonly maxOutputBytes: number;

  constructor(options: AntigravityCliAdapterOptions) {
    this.options = options;
    this.command = options.command ?? "agy";
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async startTask(args: JsonObject, context: ToolExecutionContext): Promise<JsonObject> {
    const prompt = requiredString(args, "prompt");
    const cwd = this.options.workspacePolicy.resolveProjectDirectory(optionalString(args, "project") ?? optionalString(args, "cwd"));
    await ensureExistingDirectory(cwd);
    const sandbox = effectiveSandbox(args, this.options.defaultSandbox);
    const approval = await this.ensureSandboxApproval(sandbox, cwd, prompt);
    const sessionPlan = codingSessionPlan(args, context, cwd, this.sessions);
    const taskId = `antigravity_${randomUUID()}`;
    const antigravityLogFile = antigravityCliLogFile();
    const antigravityLogStartByte = await fileSize(antigravityLogFile);
    const cliArgs = this.antigravityArgs(sandbox, sessionPlan);
    const child = this.spawnAntigravityProcess(cliArgs, cwd);

    const task: StoredCodingTask = {
      task_id: taskId,
      request_id: context.requestId,
      provider: "antigravity",
      status: "running",
      cwd,
      sandbox,
      permission_mode: this.permissionModeFromSandbox(sandbox),
      approval_required: approval.required,
      approved: approval.approved,
      approval_reason: approval.reason,
      output: "",
      agent_output: "",
      stdout: "",
      stderr: "",
      final_message: null,
      exit_code: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      events_count: 0,
      last_event_type: null,
      lease_id: context.leaseId,
      agent_id: context.agentId,
      local_task_id: context.taskId,
      event_run_id: context.eventRunId,
      session_key: sessionPlan.key,
      continue_session: sessionPlan.continueSession,
      resumed_session: sessionPlan.resumed,
      provider_session_id: sessionPlan.providerSessionId,
      antigravity_conversation_id: sessionPlan.providerSessionId,
      antigravity_log_file: antigravityLogFile,
      antigravity_log_start_byte: antigravityLogStartByte,
      process: child,
      events: [],
      nextEventIndex: 0,
      stdoutBuffer: "",
      leaseHeartbeatTimer: null,
      actionState: new Map()
    };

    this.tasks.set(taskId, task);
    this.startLeaseHeartbeat(task);
    this.appendProcessEvent(task, "process.started", {
      command: this.command,
      args: cliArgs,
      cwd,
      sandbox
    });

    child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdoutChunk(task, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      task.stderr = appendBounded(task.stderr, text, this.maxOutputBytes);
      task.output = appendBounded(task.output, text, this.maxOutputBytes);
      this.appendTextEvent(task, "stderr", "stderr.chunk", text);
      this.markBlockedFromText(task, text);
    });
    child.on("error", (error) => {
      task.status = "failed";
      task.stderr = appendBounded(task.stderr, `${error.message}\n`, this.maxOutputBytes);
      task.output = appendBounded(task.output, `${error.message}\n`, this.maxOutputBytes);
      task.finished_at = new Date().toISOString();
      task.process = null;
      this.appendProcessEvent(task, "process.error", { message: error.message });
      this.notifyTerminal(task);
    });
    child.on("close", (code) => {
      void this.handleAntigravityClose(task, code);
    });

    child.stdin.end(`${prompt.trimEnd()}\n`);
    return this.publicTask(task);
  }

  private async handleAntigravityClose(task: StoredCodingTask, code: number | null): Promise<void> {
    this.flushStdoutBuffer(task);
    task.exit_code = code;
    if (task.status !== "cancelled") {
      task.status = this.statusFromExit(task, code);
    }
    task.finished_at = new Date().toISOString();
    task.process = null;
    await this.captureAntigravityConversationId(task);
    this.appendProcessEvent(task, "process.closed", {
      exit_code: code,
      status: task.status
    });
    this.notifyTerminal(task);
  }

  private async captureAntigravityConversationId(task: StoredCodingTask): Promise<void> {
    if (task.provider_session_id || !task.antigravity_log_file) {
      return;
    }

    const conversationId = await antigravityConversationIdFromLog(
      task.antigravity_log_file,
      task.antigravity_log_start_byte ?? 0
    );
    if (!conversationId) {
      return;
    }

    task.antigravity_conversation_id = conversationId;
    task.provider_session_id = conversationId;
    rememberCodingSession(this.sessions, task, conversationId);
    this.appendProcessEvent(task, "antigravity.session_detected", {
      conversation_id: conversationId,
      source: "cli.log"
    });
  }

  async getStatus(taskId: string): Promise<JsonObject> {
    return this.publicTask(this.requireTask(taskId));
  }

  async getOutput(taskId: string, args: JsonObject = {}): Promise<JsonObject> {
    const task = this.requireTask(taskId);
    const options = outputOptions(args);
    const result = codingTaskOutputResult(task, options);
    if (options.includeEvents) {
      result.events = this.selectEvents(task, options.sinceEventIndex, options.maxEvents) as unknown as JsonValue;
    }
    return result;
  }

  async cancel(taskId: string): Promise<JsonObject> {
    const task = this.requireTask(taskId);
    if (task.process && task.status === "running") {
      task.status = "cancelled";
      task.finished_at = new Date().toISOString();
      task.process.kill("SIGTERM");
      this.appendProcessEvent(task, "process.cancelled", { reason: "cancelled by tool call" });
      this.notifyTerminal(task);
    }

    return this.publicTask(task);
  }

  private antigravityArgs(sandbox: CodexSandbox, sessionPlan: CodingSessionPlan): string[] {
    const cliArgs: string[] = [];
    if (sessionPlan.resumed && sessionPlan.providerSessionId) {
      cliArgs.push("--conversation", sessionPlan.providerSessionId);
    }
    if (sandbox === "danger-full-access") {
      cliArgs.push("--dangerously-skip-permissions");
      return cliArgs;
    }

    cliArgs.push("--sandbox");
    return cliArgs;
  }

  private spawnAntigravityProcess(cliArgs: string[], cwd: string): ChildProcessWithoutNullStreams {
    return spawn(this.command, cliArgs, {
      cwd,
      stdio: "pipe",
      env: {
        ...process.env,
        CI: process.env.CI ?? "1",
        TERM: process.env.TERM ?? "dumb",
        NO_COLOR: process.env.NO_COLOR ?? "1"
      }
    });
  }

  private permissionModeFromSandbox(sandbox: CodexSandbox): string {
    if (sandbox === "danger-full-access") {
      return "dangerously-skip-permissions";
    }

    return "sandbox";
  }

  private async ensureSandboxApproval(sandbox: CodexSandbox, cwd: string, prompt: string): Promise<ApprovalMetadata> {
    if (sandbox === "read-only") {
      return { required: false, approved: null, reason: "No approval required for Antigravity read-only task" };
    }

    if (sandbox === "workspace-write" && this.options.allowWorkspaceWrite === false) {
      throw new ToolExecutionError("approval_denied", "Antigravity workspace-write sandbox is disabled in local settings.", {
        sandbox,
        cwd
      });
    }
    if (sandbox === "workspace-write" && this.options.allowWorkspaceWrite === true) {
      return {
        required: true,
        approved: true,
        reason: "Approved by local workspace-write setting"
      };
    }

    if (sandbox === "danger-full-access" && this.options.allowDangerFullAccess !== true) {
      throw new ToolExecutionError("approval_denied", "Antigravity danger-full-access mode is disabled in local settings.", {
        sandbox,
        cwd
      });
    }
    if (sandbox === "danger-full-access" && this.options.allowDangerFullAccess === true) {
      return {
        required: true,
        approved: true,
        reason: "Approved by local full-access setting"
      };
    }

    if (!this.options.approvalProvider) {
      throw new ToolExecutionError(
        "approval_denied",
        `Approval is required to run Antigravity with ${sandbox} sandbox, but no approval provider is configured.`,
        { sandbox, cwd }
      );
    }

    const decision = await this.options.approvalProvider.requestApproval({
      tool: "coding_agent.start_task",
      summary: `Run Antigravity with ${sandbox} sandbox in ${cwd}`,
      metadata: {
        cwd,
        sandbox,
        prompt_preview: prompt.slice(0, 500)
      }
    });

    if (!decision.approved) {
      throw new ToolExecutionError(
        "approval_denied",
        `Approval denied for Antigravity ${sandbox} task: ${decision.reason ?? "No reason provided"}`,
        { sandbox, cwd, reason: decision.reason ?? null }
      );
    }

    return { required: true, approved: true, reason: decision.reason };
  }

  private handleStdoutChunk(task: StoredCodingTask, text: string): void {
    task.stdout = appendBounded(task.stdout, text, this.maxOutputBytes);
    task.stdoutBuffer += text;

    const lines = task.stdoutBuffer.split(/\r?\n/);
    task.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      this.handleStdoutLine(task, line);
    }
  }

  private flushStdoutBuffer(task: StoredCodingTask): void {
    if (!task.stdoutBuffer) {
      return;
    }
    this.handleStdoutLine(task, task.stdoutBuffer);
    task.stdoutBuffer = "";
  }

  private handleStdoutLine(task: StoredCodingTask, line: string): void {
    if (line.trim().length === 0) {
      return;
    }

    const event = parseJsonObject(line);
    if (!event) {
      task.final_message = line;
      task.output = appendBounded(task.output, `${line}\n`, this.maxOutputBytes);
      appendAgentOutput(task, line, this.maxOutputBytes);
      this.appendTextEvent(task, "stdout", "stdout.line", line);
      this.markBlockedFromText(task, line);
      return;
    }

    this.handleAntigravityEvent(task, event);
  }

  private handleAntigravityEvent(task: StoredCodingTask, event: JsonObject): void {
    const type = stringValue(event.type) ?? "antigravity.event";
    const actions = normalizeCodingTaskActions("antigravity", event, task.actionState);
    this.appendEvent(task, {
      at: new Date().toISOString(),
      source: "antigravity",
      type,
      data: event,
      ...(actions.length > 0 ? { actions } : {})
    });

    const text = structuredTextFromEvent(event);
    if (text) {
      task.final_message = text;
      task.output = appendBounded(task.output, `${text}\n`, this.maxOutputBytes);
      appendAgentOutput(task, text, this.maxOutputBytes);
      this.markBlockedFromText(task, text);
    }

    const conversationId = stringValue(event.conversation_id) ?? stringValue(event.conversationId);
    if (conversationId) {
      task.antigravity_conversation_id = conversationId;
      task.provider_session_id = conversationId;
      rememberCodingSession(this.sessions, task, conversationId);
    }

    const blockedReason = blockedReasonFromEvent(event);
    if (blockedReason) {
      this.markTaskBlocked(task, blockedReason);
    }
  }

  private statusFromExit(task: StoredCodingTask, code: number | null): CodingTaskStatus {
    if (task.blocked_reason || looksApprovalOrSandboxBlocked(task.output) || looksApprovalOrSandboxBlocked(task.stderr)) {
      task.blocked_reason ??= "Antigravity task stopped because approval, sandbox, or permission policy blocked progress.";
      return "blocked";
    }

    if (code === 0) {
      return "completed";
    }

    return "failed";
  }

  private markBlockedFromText(task: StoredCodingTask, text: string): void {
    const blockedReason = blockedReasonFromText(text);
    if (blockedReason) {
      this.markTaskBlocked(task, blockedReason);
    }
  }

  private markTaskBlocked(task: StoredCodingTask, reason: string): void {
    task.blocked_reason ??= reason;
    if (!task.output.includes(reason)) {
      task.output = appendBounded(task.output, `${reason}\n`, this.maxOutputBytes);
    }
    if (!task.agent_output.includes(reason)) {
      appendAgentOutput(task, reason, this.maxOutputBytes);
    }
    if (task.status !== "running") {
      return;
    }

    task.status = "blocked";
    task.finished_at = new Date().toISOString();
    this.appendProcessEvent(task, "process.blocked", { reason: task.blocked_reason });
    task.process?.kill("SIGTERM");
    this.notifyTerminal(task);
  }

  private appendProcessEvent(task: StoredCodingTask, type: string, data: JsonObject): void {
    this.appendEvent(task, {
      at: new Date().toISOString(),
      source: "process",
      type,
      data
    });
  }

  private appendTextEvent(task: StoredCodingTask, source: "stdout" | "stderr", type: string, text: string): void {
    this.appendEvent(task, {
      at: new Date().toISOString(),
      source,
      type,
      text
    });
  }

  private appendEvent(task: StoredCodingTask, event: Omit<CodingTaskEvent, "index">): void {
    const indexedEvent = {
      ...event,
      index: task.nextEventIndex++
    };
    task.events.push(indexedEvent);
    task.events_count = task.nextEventIndex;
    task.last_event_type = indexedEvent.type;
    this.options.onTaskEvent?.(task, indexedEvent);

    while (task.events.length > this.maxEvents) {
      task.events.shift();
    }
  }

  private selectEvents(task: StoredCodingTask, sinceEventIndex?: number, maxEvents?: number): CodingTaskEvent[] {
    const selected =
      sinceEventIndex === undefined ? task.events : task.events.filter((event) => event.index >= sinceEventIndex);
    const limit = maxEvents === undefined ? selected.length : Math.max(0, Math.floor(maxEvents));
    return selected.slice(0, limit);
  }

  private requireTask(taskId: string): StoredCodingTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown coding task: ${taskId}`);
    }

    return task;
  }

  private publicTask(task: CodingTask): JsonObject {
    return publicTask(task);
  }

  private notifyTerminal(task: StoredCodingTask): void {
    if (task.terminalCallbackCalled) {
      return;
    }

    task.terminalCallbackCalled = true;
    this.stopLeaseHeartbeat(task);
    this.options.onTaskTerminal?.(task);
  }

  private startLeaseHeartbeat(task: StoredCodingTask): void {
    if (!task.lease_id || !this.options.onTaskHeartbeat) {
      return;
    }

    task.leaseHeartbeatTimer = setInterval(() => {
      this.options.onTaskHeartbeat?.(task);
    }, 30_000);
    task.leaseHeartbeatTimer.unref?.();
  }

  private stopLeaseHeartbeat(task: StoredCodingTask): void {
    if (!task.leaseHeartbeatTimer) {
      return;
    }

    clearInterval(task.leaseHeartbeatTimer);
    task.leaseHeartbeatTimer = null;
  }
}

export class CursorCliAdapter implements CodingAgentAdapter {
  private readonly command: string;
  private readonly tasks = new Map<string, StoredCodingTask>();
  private readonly sessions = new Map<string, CodingSessionState>();
  private readonly options: CursorCliAdapterOptions;
  private readonly maxEvents: number;
  private readonly maxOutputBytes: number;

  constructor(options: CursorCliAdapterOptions) {
    this.options = options;
    this.command = options.command ?? "agent";
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async startTask(args: JsonObject, context: ToolExecutionContext): Promise<JsonObject> {
    const prompt = requiredString(args, "prompt");
    const cwd = this.options.workspacePolicy.resolveProjectDirectory(optionalString(args, "project") ?? optionalString(args, "cwd"));
    await ensureExistingDirectory(cwd);
    const sandbox = effectiveSandbox(args, this.options.defaultSandbox);
    const approval = await this.ensureSandboxApproval(sandbox, cwd, prompt);
    let sessionPlan = codingSessionPlan(args, context, cwd, this.sessions);
    if (sessionPlan.continueSession && !sessionPlan.providerSessionId) {
      const chatId = await this.createCursorChatId();
      if (chatId) {
        sessionPlan = {
          ...sessionPlan,
          providerSessionId: chatId,
          resumed: false
        };
      }
    }
    const taskId = `cursor_${randomUUID()}`;
    const model = optionalString(args, "model") ?? this.options.defaultModel;
    const cliArgs = this.cursorArgs(prompt, cwd, sandbox, model, sessionPlan);
    const child = this.spawnCursorProcess(cliArgs, cwd);

    const task: StoredCodingTask = {
      task_id: taskId,
      request_id: context.requestId,
      provider: "cursor",
      status: "running",
      cwd,
      sandbox,
      model,
      permission_mode: this.permissionModeFromSandbox(sandbox),
      approval_required: approval.required,
      approved: approval.approved,
      approval_reason: approval.reason,
      output: "",
      agent_output: "",
      stdout: "",
      stderr: "",
      final_message: null,
      exit_code: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      events_count: 0,
      last_event_type: null,
      lease_id: context.leaseId,
      agent_id: context.agentId,
      local_task_id: context.taskId,
      event_run_id: context.eventRunId,
      session_key: sessionPlan.key,
      continue_session: sessionPlan.continueSession,
      resumed_session: sessionPlan.resumed,
      provider_session_id: sessionPlan.providerSessionId,
      cursor_chat_id: sessionPlan.providerSessionId,
      process: child,
      events: [],
      nextEventIndex: 0,
      stdoutBuffer: "",
      leaseHeartbeatTimer: null,
      actionState: new Map()
    };

    this.tasks.set(taskId, task);
    if (task.provider_session_id) {
      rememberCodingSession(this.sessions, task, task.provider_session_id);
    }
    this.startLeaseHeartbeat(task);
    this.appendProcessEvent(task, "process.started", {
      command: this.command,
      args: cliArgs,
      cwd,
      sandbox
    });

    child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdoutChunk(task, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      task.stderr = appendBounded(task.stderr, text, this.maxOutputBytes);
      task.output = appendBounded(task.output, text, this.maxOutputBytes);
      this.appendTextEvent(task, "stderr", "stderr.chunk", text);
      this.markBlockedFromText(task, text);
    });
    child.on("error", (error) => {
      task.status = "failed";
      task.stderr = appendBounded(task.stderr, `${error.message}\n`, this.maxOutputBytes);
      task.output = appendBounded(task.output, `${error.message}\n`, this.maxOutputBytes);
      task.finished_at = new Date().toISOString();
      task.process = null;
      this.appendProcessEvent(task, "process.error", { message: error.message });
      this.notifyTerminal(task);
    });
    child.on("close", (code) => {
      this.flushStdoutBuffer(task);
      task.exit_code = code;
      if (task.status !== "cancelled") {
        task.status = this.statusFromExit(task, code);
      }
      task.finished_at = new Date().toISOString();
      task.process = null;
      this.appendProcessEvent(task, "process.closed", {
        exit_code: code,
        status: task.status
      });
      this.notifyTerminal(task);
    });

    child.stdin.end();
    return this.publicTask(task);
  }

  async getStatus(taskId: string): Promise<JsonObject> {
    return this.publicTask(this.requireTask(taskId));
  }

  async getOutput(taskId: string, args: JsonObject = {}): Promise<JsonObject> {
    const task = this.requireTask(taskId);
    const options = outputOptions(args);
    const result = codingTaskOutputResult(task, options);
    if (options.includeEvents) {
      result.events = this.selectEvents(task, options.sinceEventIndex, options.maxEvents) as unknown as JsonValue;
    }
    return result;
  }

  async cancel(taskId: string): Promise<JsonObject> {
    const task = this.requireTask(taskId);
    if (task.process && task.status === "running") {
      task.status = "cancelled";
      task.finished_at = new Date().toISOString();
      task.process.kill("SIGTERM");
      this.appendProcessEvent(task, "process.cancelled", { reason: "cancelled by tool call" });
      this.notifyTerminal(task);
    }

    return this.publicTask(task);
  }

  private cursorArgs(
    prompt: string,
    cwd: string,
    sandbox: CodexSandbox,
    model: string | undefined,
    sessionPlan: CodingSessionPlan
  ): string[] {
    const cliArgs = ["-p", "--output-format", "stream-json", "--stream-partial-output", "--trust", "--workspace", cwd];
    if (sessionPlan.providerSessionId) {
      cliArgs.push("--resume", sessionPlan.providerSessionId);
    }
    if (model) {
      cliArgs.push("--model", model);
    }
    if (sandbox === "read-only") {
      cliArgs.push("--mode", "ask", "--sandbox", "enabled");
    } else {
      cliArgs.push("--force", "--sandbox", sandbox === "danger-full-access" ? "disabled" : "enabled");
    }
    cliArgs.push(prompt);
    return cliArgs;
  }

  private spawnCursorProcess(cliArgs: string[], cwd: string): ChildProcessWithoutNullStreams {
    return spawn(this.command, cliArgs, {
      cwd,
      stdio: "pipe",
      env: {
        ...process.env,
        CI: process.env.CI ?? "1",
        TERM: process.env.TERM ?? "dumb",
        NO_COLOR: process.env.NO_COLOR ?? "1"
      }
    });
  }

  private async createCursorChatId(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const child = spawn(this.command, ["create-chat"], {
        stdio: "pipe",
        env: {
          ...process.env,
          CI: process.env.CI ?? "1",
          TERM: process.env.TERM ?? "dumb",
          NO_COLOR: process.env.NO_COLOR ?? "1"
        }
      });
      let output = "";
      const finish = () => {
        resolve(cursorChatIdFromText(output));
      };
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.on("error", () => resolve(undefined));
      child.on("close", finish);
    });
  }

  private permissionModeFromSandbox(sandbox: CodexSandbox): string {
    if (sandbox === "read-only") {
      return "ask";
    }
    if (sandbox === "danger-full-access") {
      return "force:sandbox-disabled";
    }
    return "force:sandbox-enabled";
  }

  private async ensureSandboxApproval(sandbox: CodexSandbox, cwd: string, prompt: string): Promise<ApprovalMetadata> {
    if (sandbox === "read-only") {
      return { required: false, approved: null, reason: "No approval required for Cursor ask mode" };
    }

    if (sandbox === "workspace-write" && this.options.allowWorkspaceWrite === false) {
      throw new ToolExecutionError("approval_denied", "Cursor workspace-write mode is disabled in local settings.", {
        sandbox,
        cwd
      });
    }
    if (sandbox === "workspace-write" && this.options.allowWorkspaceWrite === true) {
      return {
        required: true,
        approved: true,
        reason: "Approved by local workspace-write setting"
      };
    }

    if (sandbox === "danger-full-access" && this.options.allowDangerFullAccess !== true) {
      throw new ToolExecutionError("approval_denied", "Cursor danger-full-access mode is disabled in local settings.", {
        sandbox,
        cwd
      });
    }
    if (sandbox === "danger-full-access" && this.options.allowDangerFullAccess === true) {
      return {
        required: true,
        approved: true,
        reason: "Approved by local full-access setting"
      };
    }

    if (!this.options.approvalProvider) {
      throw new ToolExecutionError(
        "approval_denied",
        `Approval is required to run Cursor with ${sandbox} sandbox, but no approval provider is configured.`,
        { sandbox, cwd }
      );
    }

    const decision = await this.options.approvalProvider.requestApproval({
      tool: "coding_agent.start_task",
      summary: `Run Cursor with ${sandbox} sandbox in ${cwd}`,
      metadata: {
        cwd,
        sandbox,
        prompt_preview: prompt.slice(0, 500)
      }
    });

    if (!decision.approved) {
      throw new ToolExecutionError(
        "approval_denied",
        `Approval denied for Cursor ${sandbox} task: ${decision.reason ?? "No reason provided"}`,
        { sandbox, cwd, reason: decision.reason ?? null }
      );
    }

    return { required: true, approved: true, reason: decision.reason };
  }

  private handleStdoutChunk(task: StoredCodingTask, text: string): void {
    task.stdout = appendBounded(task.stdout, text, this.maxOutputBytes);
    task.stdoutBuffer += text;

    const lines = task.stdoutBuffer.split(/\r?\n/);
    task.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      this.handleStdoutLine(task, line);
    }
  }

  private flushStdoutBuffer(task: StoredCodingTask): void {
    if (!task.stdoutBuffer) {
      return;
    }
    this.handleStdoutLine(task, task.stdoutBuffer);
    task.stdoutBuffer = "";
  }

  private handleStdoutLine(task: StoredCodingTask, line: string): void {
    if (line.trim().length === 0) {
      return;
    }

    const event = parseJsonObject(line);
    if (!event) {
      task.final_message = line;
      task.output = appendBounded(task.output, `${line}\n`, this.maxOutputBytes);
      appendAgentOutput(task, line, this.maxOutputBytes);
      this.appendTextEvent(task, "stdout", "stdout.line", line);
      this.markBlockedFromText(task, line);
      return;
    }

    this.handleCursorEvent(task, event);
  }

  private handleCursorEvent(task: StoredCodingTask, event: JsonObject): void {
    const type = stringValue(event.type) ?? "cursor.event";
    const actions = normalizeCodingTaskActions("cursor", event, task.actionState);
    this.appendEvent(task, {
      at: new Date().toISOString(),
      source: "cursor",
      type,
      data: event,
      ...(actions.length > 0 ? { actions } : {})
    });

    const text = cursorTextFromEvent(event);
    if (text) {
      task.final_message = text;
      task.output = appendBounded(task.output, `${text}\n`, this.maxOutputBytes);
      appendAgentOutput(task, text, this.maxOutputBytes);
      this.markBlockedFromText(task, text);
    }

    const chatId = cursorChatIdFromEvent(event);
    if (chatId) {
      task.cursor_chat_id = chatId;
      task.provider_session_id = chatId;
      rememberCodingSession(this.sessions, task, chatId);
    }

    const blockedReason = blockedReasonFromEvent(event);
    if (blockedReason) {
      this.markTaskBlocked(task, blockedReason);
    }
  }

  private statusFromExit(task: StoredCodingTask, code: number | null): CodingTaskStatus {
    if (task.blocked_reason || looksApprovalOrSandboxBlocked(task.output) || looksApprovalOrSandboxBlocked(task.stderr)) {
      task.blocked_reason ??= "Cursor task stopped because approval, sandbox, or permission policy blocked progress.";
      return "blocked";
    }

    if (code === 0) {
      return "completed";
    }

    return "failed";
  }

  private markBlockedFromText(task: StoredCodingTask, text: string): void {
    const blockedReason = blockedReasonFromText(text);
    if (blockedReason) {
      this.markTaskBlocked(task, blockedReason);
    }
  }

  private markTaskBlocked(task: StoredCodingTask, reason: string): void {
    task.blocked_reason ??= reason;
    if (!task.output.includes(reason)) {
      task.output = appendBounded(task.output, `${reason}\n`, this.maxOutputBytes);
    }
    if (!task.agent_output.includes(reason)) {
      appendAgentOutput(task, reason, this.maxOutputBytes);
    }
    if (task.status !== "running") {
      return;
    }

    task.status = "blocked";
    task.finished_at = new Date().toISOString();
    this.appendProcessEvent(task, "process.blocked", { reason: task.blocked_reason });
    task.process?.kill("SIGTERM");
    this.notifyTerminal(task);
  }

  private appendProcessEvent(task: StoredCodingTask, type: string, data: JsonObject): void {
    this.appendEvent(task, {
      at: new Date().toISOString(),
      source: "process",
      type,
      data
    });
  }

  private appendTextEvent(task: StoredCodingTask, source: "stdout" | "stderr", type: string, text: string): void {
    this.appendEvent(task, {
      at: new Date().toISOString(),
      source,
      type,
      text
    });
  }

  private appendEvent(task: StoredCodingTask, event: Omit<CodingTaskEvent, "index">): void {
    const indexedEvent = {
      ...event,
      index: task.nextEventIndex++
    };
    task.events.push(indexedEvent);
    task.events_count = task.nextEventIndex;
    task.last_event_type = indexedEvent.type;
    this.options.onTaskEvent?.(task, indexedEvent);

    while (task.events.length > this.maxEvents) {
      task.events.shift();
    }
  }

  private selectEvents(task: StoredCodingTask, sinceEventIndex?: number, maxEvents?: number): CodingTaskEvent[] {
    const selected =
      sinceEventIndex === undefined ? task.events : task.events.filter((event) => event.index >= sinceEventIndex);
    const limit = maxEvents === undefined ? selected.length : Math.max(0, Math.floor(maxEvents));
    return selected.slice(0, limit);
  }

  private requireTask(taskId: string): StoredCodingTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown coding task: ${taskId}`);
    }

    return task;
  }

  private publicTask(task: CodingTask): JsonObject {
    return publicTask(task);
  }

  private notifyTerminal(task: StoredCodingTask): void {
    if (task.terminalCallbackCalled) {
      return;
    }

    task.terminalCallbackCalled = true;
    this.stopLeaseHeartbeat(task);
    this.options.onTaskTerminal?.(task);
  }

  private startLeaseHeartbeat(task: StoredCodingTask): void {
    if (!task.lease_id || !this.options.onTaskHeartbeat) {
      return;
    }

    task.leaseHeartbeatTimer = setInterval(() => {
      this.options.onTaskHeartbeat?.(task);
    }, 30_000);
    task.leaseHeartbeatTimer.unref?.();
  }

  private stopLeaseHeartbeat(task: StoredCodingTask): void {
    if (!task.leaseHeartbeatTimer) {
      return;
    }

    clearInterval(task.leaseHeartbeatTimer);
    task.leaseHeartbeatTimer = null;
  }
}

export class ClaudeCodeAdapter implements CodingAgentAdapter {
  private readonly command: string;
  private readonly tasks = new Map<string, StoredCodingTask>();
  private readonly sessions = new Map<string, CodingSessionState>();
  private readonly options: ClaudeCodeAdapterOptions;
  private readonly maxEvents: number;
  private readonly maxOutputBytes: number;

  constructor(options: ClaudeCodeAdapterOptions) {
    this.options = options;
    this.command = options.command ?? "claude";
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async startTask(args: JsonObject, context: ToolExecutionContext): Promise<JsonObject> {
    const prompt = requiredString(args, "prompt");
    const cwd = this.options.workspacePolicy.resolveProjectDirectory(optionalString(args, "project") ?? optionalString(args, "cwd"));
    await ensureExistingDirectory(cwd);
    const permissionMode = claudePermissionModeArg(args, "permission_mode") ?? this.options.permissionMode ?? "default";
    const approval = await this.ensurePermissionApproval(permissionMode, cwd, prompt);
    const sessionPlan = codingSessionPlan(args, context, cwd, this.sessions);
    const taskId = `claude_${randomUUID()}`;
    const model = optionalString(args, "model") ?? this.options.defaultModel;
    const reasoningEffort =
      claudeReasoningEffortArg(args, "reasoning_effort") ?? this.options.defaultReasoningEffort;
    const cliArgs = this.claudeArgs(permissionMode, model, reasoningEffort, sessionPlan);
    const child = spawn(this.command, cliArgs, {
      cwd,
      stdio: "pipe"
    });

    const task: StoredCodingTask = {
      task_id: taskId,
      request_id: context.requestId,
      provider: "claude-code",
      status: "running",
      cwd,
      sandbox: "read-only",
      model,
      reasoning_effort: reasoningEffort,
      permission_mode: permissionMode,
      approval_required: approval.required,
      approved: approval.approved,
      approval_reason: approval.reason,
      output: "",
      agent_output: "",
      stdout: "",
      stderr: "",
      final_message: null,
      exit_code: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      events_count: 0,
      last_event_type: null,
      lease_id: context.leaseId,
      agent_id: context.agentId,
      local_task_id: context.taskId,
      event_run_id: context.eventRunId,
      session_key: sessionPlan.key,
      continue_session: sessionPlan.continueSession,
      resumed_session: sessionPlan.resumed,
      provider_session_id: sessionPlan.providerSessionId,
      claude_session_id: sessionPlan.providerSessionId,
      process: child,
      events: [],
      nextEventIndex: 0,
      stdoutBuffer: "",
      leaseHeartbeatTimer: null,
      actionState: new Map()
    };

    this.tasks.set(taskId, task);
    this.startLeaseHeartbeat(task);
    this.appendProcessEvent(task, "process.started", {
      command: this.command,
      args: cliArgs,
      cwd,
      permission_mode: permissionMode
    });

    child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdoutChunk(task, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      task.stderr = appendBounded(task.stderr, text, this.maxOutputBytes);
      task.output = appendBounded(task.output, text, this.maxOutputBytes);
      this.appendTextEvent(task, "stderr", "stderr.chunk", text);
      this.markBlockedFromText(task, text);
    });
    child.on("error", (error) => {
      task.status = "failed";
      task.stderr = appendBounded(task.stderr, `${error.message}\n`, this.maxOutputBytes);
      task.output = appendBounded(task.output, `${error.message}\n`, this.maxOutputBytes);
      task.finished_at = new Date().toISOString();
      task.process = null;
      this.appendProcessEvent(task, "process.error", { message: error.message });
      this.notifyTerminal(task);
    });
    child.on("close", (code) => {
      this.flushStdoutBuffer(task);
      task.exit_code = code;
      if (task.status !== "cancelled") {
        task.status = this.statusFromExit(task, code);
      }
      task.finished_at = new Date().toISOString();
      task.process = null;
      this.appendProcessEvent(task, "process.closed", {
        exit_code: code,
        status: task.status
      });
      this.notifyTerminal(task);
    });

    child.stdin.end(prompt);
    return this.publicTask(task);
  }

  async getStatus(taskId: string): Promise<JsonObject> {
    return this.publicTask(this.requireTask(taskId));
  }

  async getOutput(taskId: string, args: JsonObject = {}): Promise<JsonObject> {
    const task = this.requireTask(taskId);
    const options = outputOptions(args);
    const result = codingTaskOutputResult(task, options);
    if (options.includeEvents) {
      result.events = this.selectEvents(task, options.sinceEventIndex, options.maxEvents) as unknown as JsonValue;
    }
    return result;
  }

  async cancel(taskId: string): Promise<JsonObject> {
    const task = this.requireTask(taskId);
    if (task.process && task.status === "running") {
      task.status = "cancelled";
      task.finished_at = new Date().toISOString();
      task.process.kill("SIGTERM");
      this.appendProcessEvent(task, "process.cancelled", { reason: "cancelled by tool call" });
      this.notifyTerminal(task);
    }

    return this.publicTask(task);
  }

  private claudeArgs(
    permissionMode: ClaudeCodePermissionMode,
    model?: string,
    reasoningEffort?: ClaudeCodeReasoningEffort,
    sessionPlan?: CodingSessionPlan
  ): string[] {
    const cliArgs = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", permissionMode];
    if (sessionPlan?.resumed && sessionPlan.providerSessionId) {
      cliArgs.push("--resume", sessionPlan.providerSessionId);
    }
    if (model) {
      cliArgs.push("--model", model);
    }
    if (reasoningEffort) {
      cliArgs.push("--effort", reasoningEffort);
    }
    return cliArgs;
  }

  private async ensurePermissionApproval(
    permissionMode: ClaudeCodePermissionMode,
    cwd: string,
    prompt: string
  ): Promise<ApprovalMetadata> {
    if (permissionMode === "default" || permissionMode === "plan") {
      return { required: false, approved: null, reason: `No local approval required for Claude ${permissionMode} mode` };
    }

    if (permissionMode === "acceptEdits" && this.options.allowWorkspaceWrite === false) {
      throw new ToolExecutionError("approval_denied", "Claude Code acceptEdits mode is disabled in local settings.", {
        permission_mode: permissionMode,
        cwd
      });
    }

    if (permissionMode === "acceptEdits" && this.options.allowWorkspaceWrite === true) {
      return {
        required: true,
        approved: true,
        reason: "Approved by local workspace-write setting"
      };
    }

    if (permissionMode === "bypassPermissions" && this.options.allowBypassPermissions !== true) {
      throw new ToolExecutionError("approval_denied", "Claude bypassPermissions mode is disabled in local settings.", {
        permission_mode: permissionMode,
        cwd
      });
    }

    if (!this.options.approvalProvider) {
      throw new ToolExecutionError(
        "approval_denied",
        `Approval is required to run Claude Code with ${permissionMode} permission mode, but no approval provider is configured.`,
        { permission_mode: permissionMode, cwd }
      );
    }

    const decision = await this.options.approvalProvider.requestApproval({
      tool: "coding_agent.start_task",
      summary: `Run Claude Code with ${permissionMode} permissions in ${cwd}`,
      metadata: {
        cwd,
        permission_mode: permissionMode,
        prompt_preview: prompt.slice(0, 500)
      }
    });

    if (!decision.approved) {
      throw new ToolExecutionError(
        "approval_denied",
        `Approval denied for Claude Code ${permissionMode} task: ${decision.reason ?? "No reason provided"}`,
        { permission_mode: permissionMode, cwd, reason: decision.reason ?? null }
      );
    }

    return { required: true, approved: true, reason: decision.reason };
  }

  private handleStdoutChunk(task: StoredCodingTask, text: string): void {
    task.stdout = appendBounded(task.stdout, text, this.maxOutputBytes);
    task.stdoutBuffer += text;

    const lines = task.stdoutBuffer.split(/\r?\n/);
    task.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      this.handleStdoutLine(task, line);
    }
  }

  private flushStdoutBuffer(task: StoredCodingTask): void {
    if (!task.stdoutBuffer) {
      return;
    }
    this.handleStdoutLine(task, task.stdoutBuffer);
    task.stdoutBuffer = "";
  }

  private handleStdoutLine(task: StoredCodingTask, line: string): void {
    if (line.trim().length === 0) {
      return;
    }

    const event = parseJsonObject(line);
    if (!event) {
      task.output = appendBounded(task.output, `${line}\n`, this.maxOutputBytes);
      this.appendTextEvent(task, "stdout", "stdout.line", line);
      this.markBlockedFromText(task, line);
      return;
    }

    this.handleClaudeEvent(task, event);
  }

  private handleClaudeEvent(task: StoredCodingTask, event: JsonObject): void {
    const type = stringValue(event.type) ?? "claude.event";
    const actions = normalizeCodingTaskActions("claude-code", event, task.actionState);
    this.appendEvent(task, {
      at: new Date().toISOString(),
      source: "claude",
      type,
      data: event,
      ...(actions.length > 0 ? { actions } : {})
    });

    const text = claudeTextFromEvent(event);
    if (text) {
      task.final_message = text;
      task.output = appendBounded(task.output, `${text}\n`, this.maxOutputBytes);
      appendAgentOutput(task, text, this.maxOutputBytes);
      this.markBlockedFromText(task, text);
    }

    const sessionId = stringValue(event.session_id) ?? stringValue(event.sessionId);
    if (sessionId) {
      task.claude_session_id = sessionId;
      task.provider_session_id = sessionId;
      rememberCodingSession(this.sessions, task, sessionId);
    }

    const blockedReason = blockedReasonFromEvent(event);
    if (blockedReason) {
      this.markTaskBlocked(task, blockedReason);
    }
  }

  private statusFromExit(task: StoredCodingTask, code: number | null): CodingTaskStatus {
    if (task.blocked_reason || looksApprovalOrSandboxBlocked(task.output) || looksApprovalOrSandboxBlocked(task.stderr)) {
      task.blocked_reason ??= "Claude Code task stopped because approval, sandbox, or permission policy blocked progress.";
      return "blocked";
    }

    if (code === 0) {
      return "completed";
    }

    return "failed";
  }

  private markBlockedFromText(task: StoredCodingTask, text: string): void {
    const blockedReason = blockedReasonFromText(text);
    if (blockedReason) {
      this.markTaskBlocked(task, blockedReason);
    }
  }

  private markTaskBlocked(task: StoredCodingTask, reason: string): void {
    task.blocked_reason ??= reason;
    if (!task.output.includes(reason)) {
      task.output = appendBounded(task.output, `${reason}\n`, this.maxOutputBytes);
    }
    if (!task.agent_output.includes(reason)) {
      appendAgentOutput(task, reason, this.maxOutputBytes);
    }
    if (task.status !== "running") {
      return;
    }

    task.status = "blocked";
    task.finished_at = new Date().toISOString();
    this.appendProcessEvent(task, "process.blocked", { reason: task.blocked_reason });
    task.process?.kill("SIGTERM");
    this.notifyTerminal(task);
  }

  private appendProcessEvent(task: StoredCodingTask, type: string, data: JsonObject): void {
    this.appendEvent(task, {
      at: new Date().toISOString(),
      source: "process",
      type,
      data
    });
  }

  private appendTextEvent(task: StoredCodingTask, source: "stdout" | "stderr", type: string, text: string): void {
    this.appendEvent(task, {
      at: new Date().toISOString(),
      source,
      type,
      text
    });
  }

  private appendEvent(task: StoredCodingTask, event: Omit<CodingTaskEvent, "index">): void {
    const indexedEvent = {
      ...event,
      index: task.nextEventIndex++
    };
    task.events.push(indexedEvent);
    task.events_count = task.nextEventIndex;
    task.last_event_type = indexedEvent.type;
    this.options.onTaskEvent?.(task, indexedEvent);

    while (task.events.length > this.maxEvents) {
      task.events.shift();
    }
  }

  private selectEvents(task: StoredCodingTask, sinceEventIndex?: number, maxEvents?: number): CodingTaskEvent[] {
    const selected =
      sinceEventIndex === undefined ? task.events : task.events.filter((event) => event.index >= sinceEventIndex);
    const limit = maxEvents === undefined ? selected.length : Math.max(0, Math.floor(maxEvents));
    return selected.slice(0, limit);
  }

  private requireTask(taskId: string): StoredCodingTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown coding task: ${taskId}`);
    }

    return task;
  }

  private publicTask(task: CodingTask): JsonObject {
    return publicTask(task);
  }

  private notifyTerminal(task: StoredCodingTask): void {
    if (task.terminalCallbackCalled) {
      return;
    }

    task.terminalCallbackCalled = true;
    this.stopLeaseHeartbeat(task);
    this.options.onTaskTerminal?.(task);
  }

  private startLeaseHeartbeat(task: StoredCodingTask): void {
    if (!task.lease_id || !this.options.onTaskHeartbeat) {
      return;
    }

    task.leaseHeartbeatTimer = setInterval(() => {
      this.options.onTaskHeartbeat?.(task);
    }, 30_000);
    task.leaseHeartbeatTimer.unref?.();
  }

  private stopLeaseHeartbeat(task: StoredCodingTask): void {
    if (!task.leaseHeartbeatTimer) {
      return;
    }

    clearInterval(task.leaseHeartbeatTimer);
    task.leaseHeartbeatTimer = null;
  }
}

function requiredString(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function optionalString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanArg(args: JsonObject, key: string): boolean {
  return args[key] === true;
}

function outputOptions(args: JsonObject): CodingOutputOptions {
  const sinceEventIndex = optionalNumber(args, "since_event_index");
  const maxEvents = optionalNumber(args, "max_events");
  return {
    includeEvents:
      booleanArg(args, "include_events") ||
      booleanArg(args, "debug") ||
      sinceEventIndex !== undefined ||
      maxEvents !== undefined,
    includeRaw: booleanArg(args, "include_raw") || booleanArg(args, "debug"),
    sinceEventIndex,
    maxEvents
  };
}

function sandboxArg(args: JsonObject, key: string): CodexSandbox | undefined {
  const value = args[key];
  if (typeof value !== "string") {
    return undefined;
  }
  if (SANDBOX_VALUES.includes(value as CodexSandbox)) {
    return value as CodexSandbox;
  }
  throw new Error(`${key} must be one of ${SANDBOX_VALUES.join(", ")}`);
}

function effectiveSandbox(args: JsonObject, defaultSandbox?: CodexSandbox): CodexSandbox {
  const requestedSandbox = sandboxArg(args, "sandbox");

  if (defaultSandbox === "danger-full-access") {
    return "danger-full-access";
  }

  return requestedSandbox ?? defaultSandbox ?? "read-only";
}

function reasoningEffortArg(args: JsonObject, key: string): CodexReasoningEffort | undefined {
  const value = args[key];
  if (typeof value !== "string") {
    return undefined;
  }
  if (REASONING_EFFORT_VALUES.includes(value as CodexReasoningEffort)) {
    return value as CodexReasoningEffort;
  }
  throw new Error(`${key} must be one of ${REASONING_EFFORT_VALUES.join(", ")}`);
}

function claudePermissionModeArg(args: JsonObject, key: string): ClaudeCodePermissionMode | undefined {
  const value = args[key];
  if (typeof value !== "string") {
    return undefined;
  }
  if (CLAUDE_PERMISSION_MODES.includes(value as ClaudeCodePermissionMode)) {
    return value as ClaudeCodePermissionMode;
  }
  throw new Error(`${key} must be one of ${CLAUDE_PERMISSION_MODES.join(", ")}`);
}

function claudeReasoningEffortArg(args: JsonObject, key: string): ClaudeCodeReasoningEffort | undefined {
  const value = args[key];
  if (typeof value !== "string") {
    return undefined;
  }
  if (CLAUDE_REASONING_EFFORT_VALUES.includes(value as ClaudeCodeReasoningEffort)) {
    return value as ClaudeCodeReasoningEffort;
  }
  throw new Error(`${key} must be one of ${CLAUDE_REASONING_EFFORT_VALUES.join(", ")}`);
}

function codingSessionPlan(
  args: JsonObject,
  context: ToolExecutionContext,
  cwd: string,
  sessions: Map<string, CodingSessionState>
): CodingSessionPlan {
  const continueSession = booleanArg(args, "continue_session");
  const explicitKey = optionalString(args, "session_key");
  const explicitProviderSessionId = optionalString(args, "provider_session_id");
  const key = explicitKey ?? (continueSession ? `${context.agentId ?? "agent"}:${cwd}` : undefined);
  const stored = key ? sessions.get(key) : undefined;
  const providerSessionId = continueSession
    ? explicitProviderSessionId ?? stored?.providerSessionId
    : undefined;
  return {
    key,
    continueSession,
    providerSessionId,
    resumed: continueSession && Boolean(providerSessionId)
  };
}

function rememberCodingSession(
  sessions: Map<string, CodingSessionState>,
  task: StoredCodingTask,
  providerSessionId: string
): void {
  if (!task.session_key) {
    return;
  }

  sessions.set(task.session_key, {
    providerSessionId,
    cwd: task.cwd,
    updatedAt: new Date().toISOString()
  });
}

function publicTask(task: CodingTask): JsonObject {
  const result: JsonObject = {
    task_id: task.task_id,
    provider: task.provider,
    status: task.status,
    cwd: task.cwd,
    sandbox: task.sandbox,
    approval_required: task.approval_required,
    approved: task.approved,
    exit_code: task.exit_code,
    started_at: task.started_at,
    finished_at: task.finished_at,
    final_message: task.final_message,
    events_count: task.events_count,
    last_event_type: task.last_event_type,
    continue_session: task.continue_session ?? false,
    resumed_session: task.resumed_session ?? false
  };
  if (task.git_branch) {
    result.git_branch = task.git_branch;
  }
  if (task.session_key) {
    result.session_key = task.session_key;
  }
  if (task.provider_session_id) {
    result.provider_session_id = task.provider_session_id;
  }
  if (task.model) {
    result.model = task.model;
  }
  if (task.reasoning_effort) {
    result.reasoning_effort = task.reasoning_effort;
  }
  if (task.permission_mode) {
    result.permission_mode = task.permission_mode;
  }
  if (task.approval_reason) {
    result.approval_reason = task.approval_reason;
  }
  if (task.blocked_reason) {
    result.blocked_reason = task.blocked_reason;
  }
  if (task.codex_thread_id) {
    result.codex_thread_id = task.codex_thread_id;
  }
  if (task.claude_session_id) {
    result.claude_session_id = task.claude_session_id;
  }
  if (task.antigravity_conversation_id) {
    result.antigravity_conversation_id = task.antigravity_conversation_id;
  }
  if (task.cursor_chat_id) {
    result.cursor_chat_id = task.cursor_chat_id;
  }
  if (task.lease_id) {
    result.lease_id = task.lease_id;
  }
  return result;
}

function codingTaskOutputResult(task: StoredCodingTask, options: CodingOutputOptions): JsonObject {
  const output = agentVisibleOutput(task);
  const result: JsonObject = {
    ...publicTask(task),
    output,
    message: output,
    final_message: task.final_message,
    next_event_index: task.nextEventIndex,
    events: task.events.slice(-100).map(publicCodingTaskEvent)
  };

  if (options.includeRaw) {
    result.raw_output = task.output;
    result.stdout = task.stdout;
    result.stderr = task.stderr;
  }

  return result;
}

function publicCodingTaskEvent(event: CodingTaskEvent): JsonObject {
  const result: JsonObject = {
    index: event.index,
    at: event.at,
    source: event.source,
    type: event.type
  };
  const text = publicCodingTaskEventText(event);
  if (text) {
    result.text = appendBounded("", text, 4_000);
  }
  if (event.actions?.length) {
    result.actions = event.actions as unknown as JsonValue;
  }
  if (isJsonObject(event.data?.item) && typeof event.data.item.type === "string") {
    result.item_type = event.data.item.type;
  }
  return result;
}

function publicCodingTaskEventText(event: CodingTaskEvent): string | undefined {
  if (event.actions?.[0]) {
    const action = event.actions[0];
    return action.detail || action.error || action.name;
  }
  if (event.text?.trim()) {
    return event.text.trim();
  }
  const data = event.data;
  if (!data) {
    return undefined;
  }
  if (isJsonObject(data.item)) {
    const itemText = stringValue(data.item.text) ?? stringValue(data.item.output);
    if (itemText?.trim()) {
      return itemText.trim();
    }
  }
  const directText =
    stringValue(data.result) ??
    stringValue(data.text) ??
    stringValue(data.message);
  if (directText?.trim()) {
    return directText.trim();
  }
  if (isJsonObject(data.message)) {
    return claudeContentText(data.message.content)?.trim();
  }
  return undefined;
}

function agentVisibleOutput(task: CodingTask): string {
  return task.agent_output || task.final_message || task.blocked_reason || "";
}

function appendAgentOutput(task: StoredCodingTask, text: string, maxBytes: number): void {
  const trimmed = text.trimEnd();
  if (!trimmed) {
    return;
  }

  task.agent_output = appendBounded(task.agent_output, `${trimmed}\n`, maxBytes);
  task.progress_update = appendBounded("", trimmed, Math.min(maxBytes, 4_000));
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseJsonObject(line: string): JsonObject | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function antigravityCliLogFile(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "cli.log");
}

async function fileSize(file: string): Promise<number> {
  try {
    const result = await stat(file);
    return result.size;
  } catch {
    return 0;
  }
}

async function antigravityConversationIdFromLog(file: string, startByte: number): Promise<string | undefined> {
  let log: string;
  try {
    log = await readFile(file, "utf8");
  } catch {
    return undefined;
  }

  const start = startByte > log.length ? 0 : startByte;
  const segment = log.slice(start);
  return antigravityConversationIdFromText(segment) ?? antigravityConversationIdFromText(log);
}

function antigravityConversationIdFromText(text: string): string | undefined {
  const matches = Array.from(
    text.matchAll(
      /(?:Created conversation |Print mode: conversation=)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g
    )
  );
  return matches.at(-1)?.[1];
}

async function ensureExistingDirectory(directory: string): Promise<void> {
  try {
    const result = await stat(directory);
    if (!result.isDirectory()) {
      throw new ToolExecutionError("invalid_arguments", `cwd is not a directory: ${directory}`);
    }
  } catch (error: unknown) {
    if (error instanceof ToolExecutionError) {
      throw error;
    }
    throw new ToolExecutionError("invalid_arguments", `cwd does not exist: ${directory}`);
  }
}

async function gitBranchFromDirectory(directory: string): Promise<string | undefined> {
  const gitEntry = path.join(directory, ".git");

  try {
    const gitEntryStat = await stat(gitEntry);
    let gitDirectory = gitEntry;

    if (gitEntryStat.isFile()) {
      const pointer = await readFile(gitEntry, "utf8");
      const match = /^gitdir:\s*(.+)$/m.exec(pointer);
      if (!match?.[1]) {
        return undefined;
      }
      gitDirectory = path.resolve(directory, match[1].trim());
    } else if (!gitEntryStat.isDirectory()) {
      return undefined;
    }

    const head = (await readFile(path.join(gitDirectory, "HEAD"), "utf8")).trim();
    const branch = /^ref:\s+refs\/heads\/(.+)$/.exec(head)?.[1];
    if (branch) {
      return branch;
    }
    if (/^[0-9a-f]{7,64}$/i.test(head)) {
      return `detached@${head.slice(0, 7)}`;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function structuredTextFromEvent(event: JsonObject): string | undefined {
  return claudeTextFromEvent(event);
}

function cursorTextFromEvent(event: JsonObject): string | undefined {
  if (event.type === "tool_call") {
    return undefined;
  }
  return claudeTextFromEvent(event);
}

function cursorChatIdFromEvent(event: JsonObject): string | undefined {
  return (
    stringValue(event.chat_id) ??
    stringValue(event.chatId) ??
    stringValue(event.session_id) ??
    stringValue(event.sessionId) ??
    stringValue(event.thread_id) ??
    stringValue(event.threadId) ??
    stringValue(event.conversation_id) ??
    stringValue(event.conversationId)
  );
}

function cursorChatIdFromText(text: string): string | undefined {
  const json = parseJsonObject(text.trim());
  if (json) {
    return cursorChatIdFromEvent(json) ?? stringValue(json.id);
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^[A-Za-z0-9_-]{8,}$/.test(line));
}

function claudeTextFromEvent(event: JsonObject): string | undefined {
  if (typeof event.result === "string" && event.result.trim().length > 0) {
    return event.result;
  }
  if (typeof event.text === "string" && event.text.trim().length > 0) {
    return event.text;
  }
  if (isJsonObject(event.message)) {
    const contentText = claudeContentText(event.message.content);
    if (contentText) {
      return contentText;
    }
  }
  return claudeContentText(event.content);
}

function claudeContentText(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const chunks = value
    .map((item) => (isJsonObject(item) && typeof item.text === "string" ? item.text : undefined))
    .filter((text): text is string => Boolean(text && text.trim().length > 0));
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

export function normalizeCodingTaskActions(
  provider: CodingAgentProvider,
  event: JsonObject,
  state: Map<string, CodingTaskAction> = new Map()
): CodingTaskAction[] {
  let actions: CodingTaskAction[] = [];
  if (provider === "codex") {
    actions = codexActionsFromEvent(event);
  } else if (provider === "claude-code") {
    actions = claudeActionsFromEvent(event, state);
  } else if (provider === "cursor") {
    actions = cursorActionsFromEvent(event);
  } else if (provider === "antigravity") {
    actions = antigravityActionsFromEvent(event, state);
  }

  return rememberNormalizedActions(actions, state);
}

function codexActionsFromEvent(event: JsonObject): CodingTaskAction[] {
  if (!isJsonObject(event.item)) {
    return [];
  }

  const item = event.item;
  const itemType = normalizedActionName(stringValue(item.type) ?? "");
  if (!isActionItemType(itemType)) {
    return [];
  }

  const phase = actionPhaseFromEvent(event, item);
  if (!phase) {
    return [];
  }

  const name = codexActionName(itemType, item);
  const detail = actionDetail(actionKindFromName(`${itemType} ${name}`), item);
  const id = stringValue(item.id) ?? actionFallbackId(itemType, detail);
  const error = actionError(item);
  return [{
    id,
    phase,
    kind: actionKindFromName(`${itemType} ${name}`),
    name,
    ...(detail ? { detail } : {}),
    ...(phase === "completed" ? { success: !error && !isFailedStatus(item.status) } : {}),
    ...(error ? { error } : {})
  }];
}

function claudeActionsFromEvent(
  event: JsonObject,
  state: Map<string, CodingTaskAction>
): CodingTaskAction[] {
  const blocks = claudeActionBlocks(event);
  const actions: CodingTaskAction[] = [];

  for (const block of blocks) {
    if (block.type === "tool_use") {
      const name = stringValue(block.name) ?? "tool";
      const input = isJsonObject(block.input) ? block.input : {};
      const detail = actionDetail(actionKindFromName(name), input);
      actions.push({
        id: stringValue(block.id) ?? actionFallbackId(name, detail),
        phase: "started",
        kind: actionKindFromName(name),
        name,
        ...(detail ? { detail } : {})
      });
      continue;
    }

    if (block.type !== "tool_result") {
      continue;
    }

    const id = stringValue(block.tool_use_id) ?? stringValue(block.id);
    if (!id) {
      continue;
    }
    const previous = state.get(id);
    const error = block.is_error === true
      ? claudeContentText(block.content) ?? "Tool execution failed"
      : undefined;
    actions.push({
      id,
      phase: "completed",
      kind: previous?.kind ?? "tool",
      name: previous?.name ?? "tool",
      ...(previous?.detail ? { detail: previous.detail } : {}),
      success: !error,
      ...(error ? { error } : {})
    });
  }

  return actions;
}

function claudeActionBlocks(event: JsonObject): JsonObject[] {
  const blocks: JsonObject[] = [];
  const add = (value: JsonValue | undefined) => {
    if (isJsonObject(value) && (value.type === "tool_use" || value.type === "tool_result")) {
      blocks.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(add);
    }
  };

  add(event);
  add(event.content);
  if (isJsonObject(event.message)) {
    add(event.message.content);
  }
  if (isJsonObject(event.event)) {
    add(event.event.content_block);
    add(event.event.content);
  }
  return blocks;
}

function cursorActionsFromEvent(event: JsonObject): CodingTaskAction[] {
  if (event.type !== "tool_call" || !isJsonObject(event.tool_call)) {
    return [];
  }

  const toolCall = event.tool_call;
  const namedEntry = Object.entries(toolCall)
    .find(([key, value]) => /toolCall$/i.test(key) && isJsonObject(value));
  const rawName = namedEntry?.[0] ?? stringValue(toolCall.name) ?? stringValue(event.name) ?? "tool";
  const body = namedEntry && isJsonObject(namedEntry[1]) ? namedEntry[1] : toolCall;
  const input = isJsonObject(body.args)
    ? body.args
    : isJsonObject(body.input)
      ? body.input
      : body;
  const name = rawName.replace(/ToolCall$/i, "") || rawName;
  const phase: CodingTaskActionPhase = normalizedActionName(stringValue(event.subtype) ?? "") === "completed"
    ? "completed"
    : "started";
  const detail = actionDetail(actionKindFromName(name), input);
  const error = actionError(body) ?? actionError(event);
  const id = stringValue(event.call_id) ?? stringValue(body.id) ?? actionFallbackId(name, detail);

  return [{
    id,
    phase,
    kind: actionKindFromName(name),
    name,
    ...(detail ? { detail } : {}),
    ...(phase === "completed" ? { success: !error && !isFailedStatus(body.status) } : {}),
    ...(error ? { error } : {})
  }];
}

function antigravityActionsFromEvent(
  event: JsonObject,
  state: Map<string, CodingTaskAction>
): CodingTaskAction[] {
  const conversationId = stringValue(event.conversationId) ?? stringValue(event.conversation_id) ?? "conversation";
  const stepIdx = typeof event.stepIdx === "number" ? event.stepIdx : event.step_idx;
  const step = typeof stepIdx === "number" ? String(stepIdx) : "unknown";
  const id = `${conversationId}:${step}`;

  if (isJsonObject(event.toolCall)) {
    const name = stringValue(event.toolCall.name) ?? "tool";
    const input = isJsonObject(event.toolCall.args) ? event.toolCall.args : {};
    const detail = actionDetail(actionKindFromName(name), input);
    return [{
      id,
      phase: "started",
      kind: actionKindFromName(name),
      name,
      ...(detail ? { detail } : {})
    }];
  }

  if (event.type !== "hook.post_tool_use" && event.hook_phase !== "completed") {
    return [];
  }
  const previous = state.get(id);
  const error = stringValue(event.error);
  return [{
    id,
    phase: "completed",
    kind: previous?.kind ?? "tool",
    name: previous?.name ?? "tool",
    ...(previous?.detail ? { detail: previous.detail } : {}),
    success: !error,
    ...(error ? { error } : {})
  }];
}

function rememberNormalizedActions(
  actions: CodingTaskAction[],
  state: Map<string, CodingTaskAction>
): CodingTaskAction[] {
  const normalized: CodingTaskAction[] = [];
  for (const action of actions) {
    const previous = state.get(action.id);
    const merged: CodingTaskAction = {
      ...previous,
      ...action,
      kind: action.kind ?? previous?.kind ?? "tool",
      name: action.name || previous?.name || "tool",
      ...(action.detail || previous?.detail ? { detail: action.detail || previous?.detail } : {}),
      ...(action.error || previous?.error ? { error: action.error || previous?.error } : {})
    };
    if (
      previous &&
      previous.phase === merged.phase &&
      previous.kind === merged.kind &&
      previous.name === merged.name &&
      previous.detail === merged.detail &&
      previous.success === merged.success &&
      previous.error === merged.error
    ) {
      continue;
    }
    state.set(merged.id, merged);
    normalized.push(merged);
  }
  return normalized;
}

function actionPhaseFromEvent(event: JsonObject, item: JsonObject): CodingTaskActionPhase | undefined {
  const eventType = normalizedActionName(stringValue(event.type) ?? "");
  if (eventType.endsWith("started")) return "started";
  if (eventType.endsWith("completed")) return "completed";

  const status = normalizedActionName(stringValue(item.status) ?? "");
  if (["in_progress", "running", "pending"].includes(status)) return "started";
  if (["completed", "failed", "error", "cancelled", "canceled"].includes(status)) return "completed";
  return undefined;
}

function codexActionName(itemType: string, item: JsonObject): string {
  if (itemType.includes("mcp_tool")) {
    const server = stringValue(item.server);
    const tool = stringValue(item.tool) ?? stringValue(item.name);
    return [server, tool].filter(Boolean).join(".") || itemType;
  }
  return stringValue(item.name) ?? stringValue(item.tool) ?? itemType;
}

function isActionItemType(type: string): boolean {
  return ["command", "file_change", "file_edit", "mcp_tool", "dynamic_tool", "web_search", "search", "plan", "read"]
    .some((candidate) => type.includes(candidate));
}

function actionKindFromName(value: string): CodingTaskActionKind {
  const name = normalizedActionName(value);
  if (/(command|shell|terminal|bash|execute|run_command)/.test(name)) return "command";
  if (/(plan|todo|task_update)/.test(name)) return "plan";
  if (/(file_change|file_edit|edit|write|replace|apply_patch|create_file|delete_file|move_file)/.test(name)) return "file_change";
  if (/(search|grep|glob|find_by_name|web|url|fetch)/.test(name)) return "search";
  if (/(read|view_file|list_dir|directory|codebase)/.test(name)) return "read";
  return "tool";
}

function actionDetail(kind: CodingTaskActionKind, input: JsonObject): string | undefined {
  if (kind === "command") {
    return trimmedActionDetail(findStringField(input, ["CommandLine", "command", "cmd", "shell_command"]));
  }
  if (kind === "file_change") {
    const direct = findStringField(input, ["TargetFile", "path", "file_path", "filePath", "filename"]);
    if (direct) return trimmedActionDetail(direct);
    const changes = Array.isArray(input.changes) ? input.changes : [];
    const paths = changes
      .map((change) => isJsonObject(change)
        ? findStringField(change, ["path", "file_path", "filePath", "filename"])
        : undefined)
      .filter((value): value is string => Boolean(value));
    return trimmedActionDetail(paths.join(", "));
  }
  if (kind === "search") {
    const query = findStringField(input, ["query", "Query", "pattern", "Pattern"]);
    const scope = findStringField(input, ["SearchPath", "SearchDirectory", "domain", "Url", "url"]);
    return trimmedActionDetail([query, scope].filter(Boolean).join(" · "));
  }
  if (kind === "read") {
    return trimmedActionDetail(findStringField(input, [
      "AbsolutePath",
      "DirectoryPath",
      "path",
      "file_path",
      "filePath",
      "SearchDirectory"
    ]));
  }
  if (kind === "plan") {
    return trimmedActionDetail(findStringField(input, ["text", "plan", "explanation"]));
  }
  return trimmedActionDetail(findStringField(input, ["description", "query", "name"]));
}

function actionError(value: JsonObject): string | undefined {
  if (value.is_error === true || value.success === false || isFailedStatus(value.status)) {
    return trimmedActionDetail(findStringField(value, ["error", "error_message", "message", "reason"])) ?? "Action failed";
  }
  return undefined;
}

function isFailedStatus(value: JsonValue | undefined): boolean {
  const status = normalizedActionName(stringValue(value) ?? "");
  return ["failed", "error", "errored", "cancelled", "canceled"].includes(status);
}

function actionFallbackId(name: string, detail?: string): string {
  return `${normalizedActionName(name) || "tool"}:${detail ?? "action"}`;
}

function normalizedActionName(value: string): string {
  return value.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[.\s-]+/g, "_");
}

function trimmedActionDetail(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 2_000 ? `${trimmed.slice(0, 1_999).trimEnd()}…` : trimmed;
}

function blockedReasonFromEvent(event: JsonObject): string | undefined {
  if (typeof event.type === "string" && event.type !== "error" && event.type !== "turn.failed") {
    return undefined;
  }

  const message = findStringField(event, ["message", "error", "reason"]);
  if (!message || !looksApprovalOrSandboxBlocked(message)) {
    return undefined;
  }

  return message;
}

function blockedReasonFromText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || !looksApprovalOrSandboxBlocked(trimmed)) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized.includes("bwrap: loopback") && normalized.includes("failed rtm_newaddr")) {
    return "Codex Linux sandbox could not start because this host does not allow the required bubblewrap network namespace setup. Run the connector on a normal Linux host with sandbox support, or use a trusted non-sandboxed mode only after explicitly enabling it in local settings.";
  }

  return trimmed.slice(0, 2_000);
}

function findStringField(value: JsonValue, keys: string[]): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringField(item, keys);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (!isJsonObject(value)) {
    return undefined;
  }

  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string") {
      return field;
    }
  }

  for (const field of Object.values(value)) {
    const found = findStringField(field, keys);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function looksApprovalOrSandboxBlocked(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("approval denied") ||
    normalized.includes("approval is required") ||
    normalized.includes("approval required") ||
    normalized.includes("requires approval") ||
    normalized.includes("blocked by policy") ||
    normalized.includes("blocked by local policy") ||
    normalized.includes("blocked by sandbox policy") ||
    normalized.includes("sandbox policy") ||
    normalized.includes("sandbox prevented") ||
    normalized.includes("sandbox blocked") ||
    normalized.includes("sandbox wrapper failed") ||
    normalized.includes("rejected(\"") ||
    normalized.includes("rejected(") ||
    normalized.includes("rejected: blocked") ||
    normalized.includes("permission denied") ||
    normalized.includes("operation not permitted") ||
    normalized.includes("read-only file system") ||
    normalized.includes("cannot write to read-only")
  );
}

function appendBounded(current: string, addition: string, maxBytes: number): string {
  const next = current + addition;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) {
    return next;
  }

  let trimmed = next;
  while (Buffer.byteLength(trimmed, "utf8") > maxBytes) {
    trimmed = trimmed.slice(Math.max(1, Math.floor(trimmed.length * 0.1)));
  }
  return trimmed;
}
