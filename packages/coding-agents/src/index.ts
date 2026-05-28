import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ApprovalProvider } from "@clero-local-agent/approvals";
import { ToolExecutionError, type ToolDefinition, type ToolExecutionContext } from "@clero-local-agent/mcp-runtime";
import { isJsonObject, type JsonObject, type JsonValue } from "@clero-local-agent/protocol";
import type { WorkspacePolicy } from "@clero-local-agent/workspace";

export type CodingTaskStatus = "running" | "completed" | "failed" | "blocked" | "cancelled";
export type CodingAgentProvider = "codex" | "claude-code" | "antigravity";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ClaudeCodePermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";
export type ClaudeCodeReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type CodingTaskEvent = {
  index: number;
  at: string;
  source: "codex" | "claude" | "antigravity" | "stdout" | "stderr" | "process";
  type: string;
  data?: JsonObject;
  text?: string;
};

export type CodingTask = {
  task_id: string;
  request_id: string;
  provider: CodingAgentProvider;
  status: CodingTaskStatus;
  cwd: string;
  sandbox: CodexSandbox;
  model?: string;
  reasoning_effort?: string;
  permission_mode?: string;
  approval_required: boolean;
  approved: boolean | null;
  approval_reason?: string;
  output: string;
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
        description: "Start a non-interactive local coding-agent task.",
        handler: (args, context) => this.adapter.startTask(args, context)
      },
      {
        name: "coding_agent.get_status",
        description: "Get local coding-agent task status.",
        handler: (args) => this.adapter.getStatus(requiredString(args, "task_id"))
      },
      {
        name: "coding_agent.get_output",
        description: "Get local coding-agent task output and JSONL events.",
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

type StoredCodingTask = CodingTask & {
  process: ChildProcessWithoutNullStreams | null;
  events: CodingTaskEvent[];
  nextEventIndex: number;
  stdoutBuffer: string;
  leaseHeartbeatTimer: ReturnType<typeof setInterval> | null;
  terminalCallbackCalled?: boolean;
};

type ApprovalMetadata = {
  required: boolean;
  approved: boolean | null;
  reason?: string;
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
    const cwd = this.options.workspacePolicy.resolveAllowedDirectory(optionalString(args, "cwd"));
    await ensureExistingDirectory(cwd);
    const sandbox = sandboxArg(args, "sandbox") ?? this.options.defaultSandbox ?? "read-only";
    const approval = await this.ensureSandboxApproval(sandbox, cwd, prompt);
    const taskId = `codex_${randomUUID()}`;
    const cliArgs = this.codexExecArgs(args, cwd, sandbox);
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
      sandbox,
      model: optionalString(args, "model") ?? this.options.defaultModel,
      reasoning_effort: reasoningEffortArg(args, "reasoning_effort") ?? this.options.defaultReasoningEffort,
      approval_required: approval.required,
      approved: approval.approved,
      approval_reason: approval.reason,
      output: "",
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
      process: child,
      events: [],
      nextEventIndex: 0,
      stdoutBuffer: "",
      leaseHeartbeatTimer: null
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
    const sinceEventIndex = optionalNumber(args, "since_event_index");
    const maxEvents = optionalNumber(args, "max_events");
    const events = this.selectEvents(task, sinceEventIndex, maxEvents);
    return {
      ...this.publicTask(task),
      output: task.output,
      stdout: task.stdout,
      stderr: task.stderr,
      final_message: task.final_message,
      events,
      next_event_index: task.nextEventIndex
    };
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

  private codexExecArgs(args: JsonObject, cwd: string, sandbox: CodexSandbox): string[] {
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
    if (booleanArg(args, "skip_git_repo_check")) {
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
    this.appendEvent(task, {
      at: new Date().toISOString(),
      source: "codex",
      type,
      data: event
    });

    if (type === "thread.started" && typeof event.thread_id === "string") {
      task.codex_thread_id = event.thread_id;
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
    }

    if (item.type === "command_execution" && typeof item.output === "string") {
      task.output = appendBounded(task.output, item.output, this.maxOutputBytes);
    }
  }

  private statusFromExit(task: StoredCodingTask, code: number | null): CodingTaskStatus {
    if (code === 0) {
      return "completed";
    }

    if (task.blocked_reason || looksApprovalOrSandboxBlocked(task.output) || looksApprovalOrSandboxBlocked(task.stderr)) {
      task.blocked_reason ??= "Codex task stopped because approval, sandbox, or permission policy blocked progress.";
      return "blocked";
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
    const cwd = this.options.workspacePolicy.resolveAllowedDirectory(optionalString(args, "cwd"));
    await ensureExistingDirectory(cwd);
    const sandbox = sandboxArg(args, "sandbox") ?? this.options.defaultSandbox ?? "read-only";
    const approval = await this.ensureSandboxApproval(sandbox, cwd, prompt);
    const taskId = `antigravity_${randomUUID()}`;
    const cliArgs = this.antigravityArgs(sandbox);
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
      process: child,
      events: [],
      nextEventIndex: 0,
      stdoutBuffer: "",
      leaseHeartbeatTimer: null
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

    child.stdin.end(`${prompt.trimEnd()}\n`);
    return this.publicTask(task);
  }

  async getStatus(taskId: string): Promise<JsonObject> {
    return this.publicTask(this.requireTask(taskId));
  }

  async getOutput(taskId: string, args: JsonObject = {}): Promise<JsonObject> {
    const task = this.requireTask(taskId);
    const sinceEventIndex = optionalNumber(args, "since_event_index");
    const maxEvents = optionalNumber(args, "max_events");
    const events = this.selectEvents(task, sinceEventIndex, maxEvents);
    return {
      ...this.publicTask(task),
      output: task.output,
      stdout: task.stdout,
      stderr: task.stderr,
      final_message: task.final_message,
      events,
      next_event_index: task.nextEventIndex
    };
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

  private antigravityArgs(sandbox: CodexSandbox): string[] {
    if (sandbox === "danger-full-access") {
      return ["--dangerously-skip-permissions"];
    }

    return ["--sandbox"];
  }

  private spawnAntigravityProcess(cliArgs: string[], cwd: string): ChildProcessWithoutNullStreams {
    if (process.platform === "darwin" && this.shouldUseMacPseudoTerminal()) {
      return spawn("script", ["-q", "/dev/null", this.command, ...cliArgs], {
        cwd,
        stdio: "pipe"
      });
    }

    return spawn(this.command, cliArgs, {
      cwd,
      stdio: "pipe"
    });
  }

  private shouldUseMacPseudoTerminal(): boolean {
    const name = path.basename(this.command).toLowerCase();
    return name === "agy" || name === "antigravity";
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
      this.appendTextEvent(task, "stdout", "stdout.line", line);
      this.markBlockedFromText(task, line);
      return;
    }

    this.handleAntigravityEvent(task, event);
  }

  private handleAntigravityEvent(task: StoredCodingTask, event: JsonObject): void {
    const type = stringValue(event.type) ?? "antigravity.event";
    this.appendEvent(task, {
      at: new Date().toISOString(),
      source: "antigravity",
      type,
      data: event
    });

    const text = structuredTextFromEvent(event);
    if (text) {
      task.final_message = text;
      task.output = appendBounded(task.output, `${text}\n`, this.maxOutputBytes);
    }

    const blockedReason = blockedReasonFromEvent(event);
    if (blockedReason) {
      this.markTaskBlocked(task, blockedReason);
    }
  }

  private statusFromExit(task: StoredCodingTask, code: number | null): CodingTaskStatus {
    if (code === 0) {
      return "completed";
    }

    if (task.blocked_reason || looksApprovalOrSandboxBlocked(task.output) || looksApprovalOrSandboxBlocked(task.stderr)) {
      task.blocked_reason ??= "Antigravity task stopped because approval, sandbox, or permission policy blocked progress.";
      return "blocked";
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
    const cwd = this.options.workspacePolicy.resolveAllowedDirectory(optionalString(args, "cwd"));
    await ensureExistingDirectory(cwd);
    const permissionMode = claudePermissionModeArg(args, "permission_mode") ?? this.options.permissionMode ?? "default";
    const approval = await this.ensurePermissionApproval(permissionMode, cwd, prompt);
    const taskId = `claude_${randomUUID()}`;
    const model = optionalString(args, "model") ?? this.options.defaultModel;
    const reasoningEffort =
      claudeReasoningEffortArg(args, "reasoning_effort") ?? this.options.defaultReasoningEffort;
    const cliArgs = this.claudeArgs(permissionMode, model, reasoningEffort);
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
      process: child,
      events: [],
      nextEventIndex: 0,
      stdoutBuffer: "",
      leaseHeartbeatTimer: null
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
    const sinceEventIndex = optionalNumber(args, "since_event_index");
    const maxEvents = optionalNumber(args, "max_events");
    const events = this.selectEvents(task, sinceEventIndex, maxEvents);
    return {
      ...this.publicTask(task),
      output: task.output,
      stdout: task.stdout,
      stderr: task.stderr,
      final_message: task.final_message,
      events,
      next_event_index: task.nextEventIndex
    };
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
    reasoningEffort?: ClaudeCodeReasoningEffort
  ): string[] {
    const cliArgs = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", permissionMode];
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
    this.appendEvent(task, {
      at: new Date().toISOString(),
      source: "claude",
      type,
      data: event
    });

    const text = claudeTextFromEvent(event);
    if (text) {
      task.final_message = text;
      task.output = appendBounded(task.output, `${text}\n`, this.maxOutputBytes);
    }

    const blockedReason = blockedReasonFromEvent(event);
    if (blockedReason) {
      this.markTaskBlocked(task, blockedReason);
    }
  }

  private statusFromExit(task: StoredCodingTask, code: number | null): CodingTaskStatus {
    if (code === 0) {
      return "completed";
    }

    if (task.blocked_reason || looksApprovalOrSandboxBlocked(task.output) || looksApprovalOrSandboxBlocked(task.stderr)) {
      task.blocked_reason ??= "Claude Code task stopped because approval, sandbox, or permission policy blocked progress.";
      return "blocked";
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
    last_event_type: task.last_event_type
  };
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
  if (task.lease_id) {
    result.lease_id = task.lease_id;
  }
  return result;
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

function structuredTextFromEvent(event: JsonObject): string | undefined {
  return claudeTextFromEvent(event);
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
    normalized.includes("approval") ||
    normalized.includes("sandbox") ||
    normalized.includes("blocked by policy") ||
    normalized.includes("blocked by local policy") ||
    normalized.includes("blocked by sandbox policy") ||
    normalized.includes("rejected(\"") ||
    normalized.includes("rejected(") ||
    normalized.includes("rejected: blocked") ||
    normalized.includes("permission denied") ||
    normalized.includes("operation not permitted") ||
    normalized.includes("read-only")
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
