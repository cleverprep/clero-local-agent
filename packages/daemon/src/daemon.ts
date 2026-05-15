import { createDefaultApprovalProvider } from "@clero-local-agent/approvals";
import { BrowserTools, ManagedBrowserAdapter, McpChromeBrowserAdapter, type BrowserAdapter } from "@clero-local-agent/browser";
import {
  ClaudeCodeAdapter,
  CodexCliAdapter,
  CodingAgentTools,
  type ClaudeCodePermissionMode,
  type ClaudeCodeReasoningEffort,
  type CodingAgentAdapter,
  type CodingAgentProvider,
  type CodexReasoningEffort,
  type CodexSandbox,
  type CodingTask
} from "@clero-local-agent/coding-agents";
import { GitTools } from "@clero-local-agent/git-tools";
import { ToolRegistry, toolCallArguments, toolCallRunContext } from "@clero-local-agent/mcp-runtime";
import {
  errorControlResult,
  isControlRequestMessage,
  isJsonObject,
  isToolCallMessage,
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
  private readonly pendingRuntimeMessages: RuntimeMessage[] = [];

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
      this.leaseManager.clearActiveLease();
      this.stopHeartbeat();
    });
    await this.websocket.start();
  }

  async stop(): Promise<void> {
    await this.websocket.stop();
    this.stopHeartbeat();
    this.leaseManager.clearActiveLease();
    await this.browserAdapter?.dispose?.();
  }

  getLeaseManager(): LeaseManager {
    return this.leaseManager;
  }

  private enqueueMessage(message: unknown): void {
    this.messageQueue = this.messageQueue
      .then(() => this.handleMessage(message))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error("failed to handle runtime message", { error: detail });
      });
  }

  private async handleMessage(message: unknown): Promise<void> {
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

  private sendHello(): void {
    const message = {
      type: "hello",
      platform: process.platform,
      daemon_version: this.options.daemonVersion ?? "0.1.2",
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
        if (!agentId || !taskId) {
          return errorControlResult(message.request_id, "invalid_arguments", "agent_id and task_id are required");
        }

        const result = this.leaseManager.acquireLease({
          agentId,
          taskId,
          requestedTools,
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
    const approvalProvider = createDefaultApprovalProvider(this.options.interactiveApprovals ?? process.stdin.isTTY);
    const browserAdapter =
      this.options.browserProvider === "mcp-chrome"
        ? new McpChromeBrowserAdapter({
            endpointUrl: this.options.browserMcpUrl ?? "http://127.0.0.1:12306/mcp"
          })
        : new ManagedBrowserAdapter({
            userDataDir: this.options.browserProfileDir,
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

  private createCodingAgentAdapter(workspacePolicy: WorkspacePolicy, approvalProvider: ReturnType<typeof createDefaultApprovalProvider>): CodingAgentAdapter {
    const callbacks = {
      onTaskHeartbeat: (task: CodingTask) => {
        if (task.lease_id) {
          this.leaseManager.heartbeatLease(task.lease_id);
        }
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
        allowBypassPermissions: codingConfig.allowDangerFullAccess,
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

export function createDaemon(options: LocalRuntimeDaemonOptions): LocalRuntimeDaemon {
  return new LocalRuntimeDaemon(options);
}
