import {
  createDefaultApprovalProvider,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  WebSocketApprovalProvider,
  type ApprovalProvider
} from "@clero-local-agent/approvals";
import { AgentScopedManagedBrowserAdapter, BrowserTools, McpChromeBrowserAdapter, type BrowserAdapter } from "@clero-local-agent/browser";
import {
  AntigravityCliAdapter,
  ClaudeCodeAdapter,
  CodexCliAdapter,
  CodingAgentTools,
  type ClaudeCodePermissionMode,
  type ClaudeCodeReasoningEffort,
  type CodingAgentAdapter,
  type CodingAgentProvider,
  type CodexReasoningEffort,
  type CodexSandbox,
  type CodingTask,
  type CodingTaskEvent
} from "@clero-local-agent/coding-agents";
import { GitTools } from "@clero-local-agent/git-tools";
import { ToolRegistry, toolCallArguments, toolCallRunContext } from "@clero-local-agent/mcp-runtime";
import {
  errorControlResult,
  isAgentsSyncMessage,
  isApprovalResponseMessage,
  isControlRequestMessage,
  isJsonObject,
  isToolCallMessage,
  type ApprovalRequestMessage,
  type ApprovalResponseMessage,
  okControlResult,
  type ControlRequestMessage,
  type ControlResultMessage,
  type JsonObject,
  type LocalTaskCompletedMessage,
  type RuntimeMessage
} from "@clero-local-agent/protocol";
import { WorkspacePolicy, WorkspaceTools } from "@clero-local-agent/workspace";
import { ConsoleAuditLogger, type AuditLogger } from "./audit-log.ts";
import { LeaseManager } from "./lease-manager.ts";
import { ConsoleLogger, type Logger } from "./logger.ts";
import { RuntimeWebSocketClient } from "./websocket-client.ts";

export type LocalRuntimeDaemonOptions = {
  wsUrl: string;
  token: string;
  allowedDirectories: string[];
  daemonVersion?: string;
  browserProvider?: "managed" | "mcp-chrome";
  browserMcpUrl?: string;
  browserProfileDir?: string;
  browserRememberSession?: boolean;
  browserHeadless?: boolean;
  browserChannel?: "chromium" | "chrome" | "chrome-beta" | "msedge";
  logger?: Logger;
  auditLogger?: AuditLogger;
  interactiveApprovals?: boolean;
  capabilities?: LocalRuntimeCapabilityOptions;
};

export type LocalRuntimeCapabilityOptions = {
  browser?: {
    enabled?: boolean;
  };
  workspace?: {
    enabled?: boolean;
  };
  codex?: {
    enabled?: boolean;
    provider?: CodingAgentProvider;
    command?: string;
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    antigravityCommand?: string;
    claudeCommand?: string;
    claudeModel?: string;
    claudeReasoningEffort?: ClaudeCodeReasoningEffort;
    claudePermissionMode?: ClaudeCodePermissionMode;
    defaultSandbox?: CodexSandbox;
    allowWorkspaceWrite?: boolean;
    allowDangerFullAccess?: boolean;
  };
  git?: {
    readEnabled?: boolean;
    writeEnabled?: boolean;
  };
};

type PendingApprovalRequest = {
  resolve: (message: ApprovalResponseMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class LocalRuntimeDaemon {
  private readonly logger: Logger;
  private readonly auditLogger: AuditLogger;
  private readonly leaseManager = new LeaseManager();
  private readonly registry = new ToolRegistry();
  private readonly websocket: RuntimeWebSocketClient;
  private readonly options: LocalRuntimeDaemonOptions;
  private messageQueue: Promise<void> = Promise.resolve();
  private browserAdapter: BrowserAdapter | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastRuntimeMessageAtMs = 0;
  private readonly pendingRuntimeMessages: RuntimeMessage[] = [];
  private readonly pendingApprovalRequests = new Map<string, PendingApprovalRequest>();

  constructor(options: LocalRuntimeDaemonOptions) {
    this.options = options;
    this.logger = options.logger ?? new ConsoleLogger("info");
    this.auditLogger = options.auditLogger ?? new ConsoleAuditLogger();
    this.websocket = new RuntimeWebSocketClient({
      url: options.wsUrl,
      token: options.token,
      logger: this.logger
    });

    this.registerTools();
  }

  async start(): Promise<void> {
    this.websocket.on("message", (message: unknown) => {
      this.enqueueMessage(message);
    });
    this.websocket.on("close", () => {
      this.lastRuntimeMessageAtMs = 0;
      this.leaseManager.clearActiveLease();
      this.rejectPendingApprovalRequests("WebSocket closed before approval response");
      this.stopHeartbeat();
    });
    await this.websocket.start();
  }

  async stop(): Promise<void> {
    await this.websocket.stop();
    this.stopHeartbeat();
    this.leaseManager.clearActiveLease();
    this.rejectPendingApprovalRequests("Daemon stopped before approval response");
    await this.browserAdapter?.dispose?.();
  }

  getLeaseManager(): LeaseManager {
    return this.leaseManager;
  }

  private enqueueMessage(message: unknown): void {
    if (isApprovalResponseMessage(message)) {
      this.handleMessage(message).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error("failed to handle approval response", { error: detail });
      });
      return;
    }

    this.messageQueue = this.messageQueue
      .then(() => this.handleMessage(message))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error("failed to handle runtime message", { error: detail });
      });
  }

  private async handleMessage(message: unknown): Promise<void> {
    this.lastRuntimeMessageAtMs = Date.now();

    if (isConnectedMessage(message)) {
      this.logger.info("local runtime session established", {
        connectionId: message.connection_id,
        sessionId: message.session_id
      });
      this.sendHello();
      this.flushPendingRuntimeMessages();
      this.startHeartbeat();
      return;
    }

    if (isHelloAckMessage(message)) {
      this.logger.info("local runtime hello acknowledged");
      return;
    }

    if (isAgentsSyncMessage(message)) {
      this.logger.info("local runtime agents synchronized", {
        connectionId: message.connection_id,
        agentCount: message.agents.length
      });
      return;
    }

    if (isHeartbeatAckMessage(message)) {
      return;
    }

    if (isBackendErrorMessage(message)) {
      this.logger.warn("local runtime backend error", {
        errorCode: message.error_code,
        backendMessage: message.message
      });
      return;
    }

    if (isApprovalResponseMessage(message)) {
      this.resolveApprovalResponse(message);
      return;
    }

    if (isControlRequestMessage(message)) {
      this.sendRuntimeMessage(this.handleControlRequest(message));
      return;
    }

    if (isToolCallMessage(message)) {
      const runContext = toolCallRunContext(message);
      const toolArguments = toolCallArguments(message);
      const result = await this.registry.execute(message, this.leaseManager);
      this.auditLogger.record({
        at: new Date().toISOString(),
        event: "tool_call",
        requestId: message.request_id,
        agentId: runContext.agentId,
        taskId: runContext.taskId,
        eventRunId: runContext.eventRunId,
        requestedActionKey: message.requested_action_key,
        leaseId: message.lease_id,
        tool: message.tool,
        metadata: toolArguments,
        result
      });
      this.sendRuntimeMessage(result);
      return;
    }

    this.logger.warn("ignored unknown runtime message");
  }

  private resolveApprovalResponse(message: ApprovalResponseMessage): void {
    const pending = this.pendingApprovalRequests.get(message.request_id);
    if (!pending) {
      this.logger.warn("received approval response for unknown request", {
        requestId: message.request_id
      });
      return;
    }

    this.pendingApprovalRequests.delete(message.request_id);
    clearTimeout(pending.timeout);
    pending.resolve(message);
  }

  private sendHello(): void {
    const message = {
      type: "hello",
      platform: process.platform,
      daemon_version: this.options.daemonVersion ?? "0.1.9",
      capabilities: { tools: this.registry.capabilities() }
    } as const;
    this.logger.info("sending local runtime capabilities hello", {
      outbound: message
    });
    this.sendRuntimeMessage(message);
    this.logger.info("sent local runtime hello", {
      toolCount: message.capabilities.tools.length
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 15_000);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private sendHeartbeat(): void {
    if (this.lastRuntimeMessageAtMs > 0 && Date.now() - this.lastRuntimeMessageAtMs > 60_000) {
      this.logger.warn("local runtime websocket heartbeat timed out", {
        lastSeenMs: this.lastRuntimeMessageAtMs
      });
      this.websocket.reconnect();
      return;
    }

    try {
      this.sendRuntimeMessage({
        type: "heartbeat",
        capabilities: { tools: this.registry.capabilities() }
      }, { queueOnFailure: false });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn("failed to send local runtime heartbeat", { error: detail });
    }
  }

  private sendRuntimeMessage(
    message: RuntimeMessage,
    options: { queueOnFailure?: boolean } = {}
  ): void {
    try {
      this.websocket.send(message);
    } catch (error: unknown) {
      if (options.queueOnFailure === false) {
        throw error;
      }
      this.pendingRuntimeMessages.push(message);
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn("queued runtime message until websocket reconnects", {
        type: message.type,
        pending: this.pendingRuntimeMessages.length,
        error: detail
      });
    }
  }

  private sendApprovalRequest(message: ApprovalRequestMessage): Promise<ApprovalResponseMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingApprovalRequests.delete(message.request_id);
        resolve({
          type: "approval_response",
          request_id: message.request_id,
          approved: false,
          reason: "Approval timed out"
        });
      }, DEFAULT_APPROVAL_TIMEOUT_MS);

      this.pendingApprovalRequests.set(message.request_id, {
        resolve,
        reject,
        timeout
      });

      try {
        this.websocket.send(message);
      } catch (error: unknown) {
        this.pendingApprovalRequests.delete(message.request_id);
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private rejectPendingApprovalRequests(reason: string): void {
    for (const [requestId, pending] of this.pendingApprovalRequests) {
      this.pendingApprovalRequests.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
  }

  private flushPendingRuntimeMessages(): void {
    while (this.pendingRuntimeMessages.length > 0) {
      const message = this.pendingRuntimeMessages[0];
      try {
        this.websocket.send(message);
        this.pendingRuntimeMessages.shift();
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn("failed to flush queued runtime message", {
          type: message.type,
          pending: this.pendingRuntimeMessages.length,
          error: detail
        });
        return;
      }
    }
  }

  private sendCodingTaskCompletion(task: CodingTask): void {
    this.auditLogger.record({
      at: new Date().toISOString(),
      event: "coding_task_completed",
      requestId: task.request_id,
      agentId: task.agent_id,
      taskId: task.local_task_id,
      eventRunId: task.event_run_id,
      tool: "coding_agent.start_task",
      metadata: {
        local_task_id: task.task_id,
        provider: task.provider,
        status: task.status,
        cwd: task.cwd
      },
      result: {
        final_message: task.final_message,
        exit_code: task.exit_code,
        output_tail: tailText(task.output)
      }
    });

    const message: LocalTaskCompletedMessage = {
      type: "local_task_completed",
      request_id: task.request_id,
      tool: "coding_agent.start_task",
      agent_id: task.agent_id,
      event_run_id: task.event_run_id ?? task.local_task_id,
      task_id: task.task_id,
      local_task_id: task.task_id,
      status: task.status,
      result: {
        provider: task.provider,
        request_id: task.request_id,
        final_message: task.final_message,
        exit_code: task.exit_code,
        cwd: task.cwd,
        output_tail: tailText(task.output)
      }
    };
    this.sendRuntimeMessage(message);
  }

  private handleControlRequest(message: ControlRequestMessage): ControlResultMessage {
    const args = message.arguments ?? {};

    switch (message.action) {
      case "acquire_lease": {
        const agentId = stringArg(args, "agent_id");
        const taskId = stringArg(args, "task_id");
        const requestedTools = stringArrayArg(args, "requested_tools");
        const ttlSeconds = numberArg(args, "ttl_seconds");
        const workspaceKey = stringArg(args, "workspace_key");
        if (!agentId || !taskId) {
          return errorControlResult(message.request_id, "invalid_arguments", "agent_id and task_id are required");
        }

        const result = this.leaseManager.acquireLease({
          agentId,
          taskId,
          requestedTools,
          workspaceKey,
          ttlSeconds
        });
        if (result.status === "granted") {
          return okControlResult(message.request_id, result.lease);
        }
        if (result.status === "busy") {
          return errorControlResult(message.request_id, "busy", "Another agent owns the active lease.", {
            active_lease: result.activeLease as unknown as JsonObject
          });
        }
        if (result.status === "slot_limit") {
          return errorControlResult(message.request_id, "slot_limit", "The local runtime already has a connected agent.");
        }
        return errorControlResult(message.request_id, "invalid_arguments", result.message);
      }

      case "heartbeat_lease": {
        const leaseId = stringArg(args, "lease_id");
        if (!leaseId) {
          return errorControlResult(message.request_id, "invalid_arguments", "lease_id is required");
        }

        const result = this.leaseManager.heartbeatLease(leaseId, numberArg(args, "ttl_seconds"));
        if (result.status === "ok") {
          return okControlResult(message.request_id, result.lease);
        }
        return errorControlResult(
          message.request_id,
          result.status === "expired" ? "lease_expired" : "not_found",
          "Lease is not active."
        );
      }

      case "release_lease": {
        const leaseId = stringArg(args, "lease_id");
        if (!leaseId) {
          return errorControlResult(message.request_id, "invalid_arguments", "lease_id is required");
        }

        const result = this.leaseManager.releaseLease(leaseId);
        if (result.status === "released") {
          return okControlResult(message.request_id, { released: true });
        }
        return errorControlResult(message.request_id, "not_found", "Lease is not active.");
      }

      case "get_daemon_status":
        return okControlResult(message.request_id, this.leaseManager.getStatus() as unknown as JsonObject);

      case "list_capabilities":
        return okControlResult(message.request_id, this.registry.capabilities() as unknown as JsonObject[]);

      default:
        return errorControlResult(message.request_id, "unknown_message", `Unknown control action: ${message.action}`);
    }
  }

  private registerTools(): void {
    const workspacePolicy = new WorkspacePolicy({ allowedDirectories: this.options.allowedDirectories });
    const approvalProvider = this.createApprovalProvider();
    const browserAdapter =
      this.options.browserProvider === "mcp-chrome"
        ? new McpChromeBrowserAdapter({
            endpointUrl: this.options.browserMcpUrl
          })
        : new AgentScopedManagedBrowserAdapter({
            userDataDir: this.options.browserProfileDir,
            rememberSession: this.options.browserRememberSession,
            headless: this.options.browserHeadless,
            browserChannel: this.options.browserChannel
          });
    this.browserAdapter = browserAdapter;
    const browserTools = new BrowserTools(browserAdapter);
    const workspaceTools = new WorkspaceTools(workspacePolicy);
    const codingAgentTools = new CodingAgentTools(this.createCodingAgentAdapter(workspacePolicy, approvalProvider));
    const gitTools = new GitTools({ workspacePolicy, approvalProvider });

    if (this.options.capabilities?.browser?.enabled !== false) {
      for (const definition of browserTools.definitions()) {
        this.registry.register(definition);
      }
    }
    if (this.options.capabilities?.workspace?.enabled !== false) {
      for (const definition of workspaceTools.definitions()) {
        this.registry.register(definition);
      }
    }
    if (this.options.capabilities?.codex?.enabled !== false) {
      for (const definition of codingAgentTools.definitions()) {
        this.registry.register(definition);
      }
    }
    for (const definition of gitTools.definitions()) {
      if (!this.gitToolEnabled(definition.name)) {
        continue;
      }
      this.registry.register(definition);
    }
  }

  private createApprovalProvider(): ApprovalProvider {
    if (this.options.interactiveApprovals === false) {
      return createDefaultApprovalProvider(false);
    }

    if (this.options.interactiveApprovals === true || process.stdin.isTTY === true) {
      return createDefaultApprovalProvider(true);
    }

    return new WebSocketApprovalProvider((message) => this.sendApprovalRequest(message));
  }

  private createCodingAgentAdapter(workspacePolicy: WorkspacePolicy, approvalProvider: ApprovalProvider): CodingAgentAdapter {
    const callbacks = {
      onTaskHeartbeat: (task: CodingTask) => {
        if (task.lease_id) {
          this.leaseManager.heartbeatLease(task.lease_id);
        }
      },
      onTaskEvent: (task: CodingTask, event: CodingTaskEvent) => {
        const text = codingTaskEventText(event);
        if (!text && event.source !== "process") {
          return;
        }
        this.auditLogger.record({
          at: event.at,
          event: "coding_task_event",
          requestId: task.request_id,
          agentId: task.agent_id,
          taskId: task.local_task_id,
          eventRunId: task.event_run_id,
          tool: "coding_agent.start_task",
          metadata: {
            local_task_id: task.task_id,
            provider: task.provider,
            status: task.status,
            cwd: task.cwd,
            event_index: event.index,
            event_type: event.type,
            source: event.source
          },
          result: {
            text: text ?? processEventLabel(event),
            event_type: event.type
          }
        });
      },
      onTaskTerminal: (task: CodingTask) => {
        if (task.lease_id) {
          this.leaseManager.releaseLease(task.lease_id);
        }
        this.sendCodingTaskCompletion(task);
      }
    };
    const codingConfig = this.options.capabilities?.codex;
    if (codingConfig?.provider === "claude-code") {
      return new ClaudeCodeAdapter({
        workspacePolicy,
        approvalProvider,
        command: codingConfig.claudeCommand || process.env.CLERO_LOCAL_AGENT_CLAUDE_BIN,
        defaultModel: codingConfig.claudeModel,
        defaultReasoningEffort: codingConfig.claudeReasoningEffort,
        permissionMode: codingConfig.claudePermissionMode,
        allowWorkspaceWrite: codingConfig.allowWorkspaceWrite,
        allowBypassPermissions: codingConfig.allowDangerFullAccess,
        ...callbacks
      });
    }

    if (codingConfig?.provider === "antigravity") {
      return new AntigravityCliAdapter({
        workspacePolicy,
        approvalProvider,
        command: codingConfig.antigravityCommand || process.env.CLERO_LOCAL_AGENT_ANTIGRAVITY_BIN,
        defaultSandbox: codingConfig.defaultSandbox,
        allowWorkspaceWrite: codingConfig.allowWorkspaceWrite,
        allowDangerFullAccess: codingConfig.allowDangerFullAccess,
        ...callbacks
      });
    }

    return new CodexCliAdapter({
      workspacePolicy,
      approvalProvider,
      command: codingConfig?.command || process.env.CLERO_LOCAL_AGENT_CODEX_BIN,
      defaultModel: codingConfig?.model,
      defaultReasoningEffort: codingConfig?.reasoningEffort,
      defaultSandbox: codingConfig?.defaultSandbox,
      allowWorkspaceWrite: codingConfig?.allowWorkspaceWrite,
      allowDangerFullAccess: codingConfig?.allowDangerFullAccess,
      ...callbacks
    });
  }

  private gitToolEnabled(toolName: string): boolean {
    if (toolName === "git.status" || toolName === "git.diff") {
      return this.options.capabilities?.git?.readEnabled !== false;
    }

    if (toolName === "git.commit" || toolName === "git.push") {
      return this.options.capabilities?.git?.writeEnabled !== false;
    }

    return true;
  }
}

function stringArg(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function isConnectedMessage(value: unknown): value is { type: "connected"; connection_id?: number; session_id?: string } {
  return isJsonObject(value) && value.type === "connected";
}

function isHelloAckMessage(value: unknown): value is { type: "hello_ack" } {
  return isJsonObject(value) && value.type === "hello_ack";
}

function isHeartbeatAckMessage(value: unknown): value is { type: "heartbeat_ack" } {
  return isJsonObject(value) && value.type === "heartbeat_ack";
}

function isBackendErrorMessage(value: unknown): value is { type: "error"; error_code?: string; message?: string } {
  return isJsonObject(value) && value.type === "error";
}

function numberArg(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

function stringArrayArg(args: JsonObject, key: string): string[] {
  const value = args[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function tailText(value: string, maxChars = 8_000): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(value.length - maxChars);
}

function codingTaskEventText(event: CodingTaskEvent): string | undefined {
  if (event.text?.trim()) {
    return tailText(event.text.trim(), 4_000);
  }

  const data = event.data;
  if (!data) {
    return undefined;
  }

  if (typeof data.result === "string" && data.result.trim()) {
    return tailText(data.result.trim(), 4_000);
  }
  if (typeof data.text === "string" && data.text.trim()) {
    return tailText(data.text.trim(), 4_000);
  }
  if (typeof data.message === "string" && data.message.trim()) {
    return tailText(data.message.trim(), 4_000);
  }

  if (isJsonObject(data.item)) {
    if (typeof data.item.text === "string" && data.item.text.trim()) {
      return tailText(data.item.text.trim(), 4_000);
    }
    if (typeof data.item.output === "string" && data.item.output.trim()) {
      return tailText(data.item.output.trim(), 4_000);
    }
  }

  if (isJsonObject(data.message) && Array.isArray(data.message.content)) {
    const text = data.message.content
      .map((part) => (isJsonObject(part) && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) {
      return tailText(text, 4_000);
    }
  }

  return undefined;
}

function processEventLabel(event: CodingTaskEvent): string {
  if (event.type === "process.started") {
    return "Started local coding task.";
  }
  if (event.type === "process.closed") {
    const status = isJsonObject(event.data) && typeof event.data.status === "string" ? event.data.status : "finished";
    return `Local coding task ${status}.`;
  }
  if (event.type === "process.error" && isJsonObject(event.data) && typeof event.data.message === "string") {
    return event.data.message;
  }
  if (event.type === "process.cancelled") {
    return "Local coding task cancelled.";
  }
  return event.type;
}

export function createDaemon(options: LocalRuntimeDaemonOptions): LocalRuntimeDaemon {
  return new LocalRuntimeDaemon(options);
}
