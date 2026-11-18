import os from "node:os";
import {
  createDefaultApprovalProvider,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  WebSocketApprovalProvider,
  type ApprovalProvider,
  type ApprovalRequest
} from "@clero-local-agent/approvals";
import {
  AgentScopedManagedBrowserAdapter,
  BrowserDebugTools,
  BrowserTools,
  ChromeDevToolsBrowserDebugAdapter,
  McpChromeBrowserAdapter,
  type BrowserAdapter,
  type BrowserDebugAdapter,
  type BrowserViewport
} from "@clero-local-agent/browser";
import {
  AntigravityCliAdapter,
  ClaudeCodeAdapter,
  CodexCliAdapter,
  CursorCliAdapter,
  CODING_AGENT_GRANT_RULES_VERSION,
  CODING_AGENT_PROVIDERS,
  CodingAgentTools,
  codingAgentCommand,
  codingTaskEventItemType,
  detectCodingAgents,
  findStoredCodingSession,
  isCodingAgentProvider,
  normalizeCodingAgentProviders,
  type ClaudeCodePermissionMode,
  type AntigravityReasoningEffort,
  type ClaudeCodeReasoningEffort,
  type CodingAgentAdapter,
  type CodingAgentProvider,
  type CodexReasoningEffort,
  type CodexSandbox,
  type CodingSessionState,
  type CodingTask,
  type CodingTaskEvent
} from "@clero-local-agent/coding-agents";
import {
  FilesystemTools,
  OfficialFilesystemMcpClient,
  type FilesystemMcpClient
} from "@clero-local-agent/filesystem";
import { GitTools } from "@clero-local-agent/git-tools";
import { ShellTools, type ShellAccess } from "@clero-local-agent/shell-tools";
import {
  ToolExecutionError,
  ToolRegistry,
  toolCallArguments,
  toolCallRunContext,
  type ToolExecutionContext
} from "@clero-local-agent/mcp-runtime";
import {
  errorControlResult,
  isAgentsSyncMessage,
  isApprovalResponseMessage,
  isControlRequestMessage,
  isJsonObject,
  isToolCallMessage,
  type AgentsSyncMessage,
  type ApprovalRequestMessage,
  type ApprovalResponseMessage,
  okControlResult,
  type ControlRequestMessage,
  type ControlResultMessage,
  type JsonObject,
  type JsonValue,
  type LocalTaskCompletedMessage,
  type LocalTaskEventMessage,
  type RuntimeCapabilitySettings,
  type RuntimeMessage
} from "@clero-local-agent/protocol";
import {
  withBackendAuthorizedDirectories,
  WorkspacePolicy,
  WorkspaceTools
} from "@clero-local-agent/workspace";
import { ConsoleAuditLogger, type AuditLogger } from "./audit-log.ts";
import { LeaseManager } from "./lease-manager.ts";
import { ConsoleLogger, type Logger } from "./logger.ts";
import { RuntimeWebSocketClient } from "./websocket-client.ts";
import { saveAgentsSyncSnapshot } from "./runtime-config.ts";

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
  browserViewport?: BrowserViewport;
  agentsSyncPath?: string;
  logger?: Logger;
  auditLogger?: AuditLogger;
  interactiveApprovals?: boolean;
  connectionRefreshIntervalMs?: number;
  codingAgentConfiguration?: {
    get: () => Promise<JsonObject> | JsonObject;
    set: (config: JsonObject) => Promise<JsonObject>;
  };
  /** Enabled non-default harnesses the host found missing; skipped for this run only. */
  unavailableCodingProviders?: CodingAgentProvider[];
  capabilities?: LocalRuntimeCapabilityOptions;
};

export type LocalRuntimeCapabilityOptions = {
  browser?: {
    enabled?: boolean;
  };
  browserDebug?: {
    enabled?: boolean;
    command?: string;
    args?: string[];
    browserUrl?: string;
  };
  workspace?: {
    enabled?: boolean;
  };
  shell?: {
    enabled?: boolean;
    defaultAccess?: ShellAccess;
    allowWorkspaceWrite?: boolean;
    allowDangerFullAccess?: boolean;
    defaultTimeoutMs?: number;
    defaultMaxOutputBytes?: number;
    shell?: string;
  };
  codex?: {
    enabled?: boolean;
    /** Default harness, used when coding_agent.start_task omits provider. */
    provider?: CodingAgentProvider;
    /** Enabled harnesses. Missing means only the default harness. */
    providers?: CodingAgentProvider[];
    command?: string;
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    antigravityCommand?: string;
    antigravityModel?: string;
    antigravityReasoningEffort?: AntigravityReasoningEffort;
    cursorCommand?: string;
    cursorModel?: string;
    claudeCommand?: string;
    claudeModel?: string;
    claudeReasoningEffort?: ClaudeCodeReasoningEffort;
    claudePermissionMode?: ClaudeCodePermissionMode;
    defaultSandbox?: CodexSandbox;
    /** Shared write grant as configured; see codingHarnessAccess for each harness's effective access. */
    allowWorkspaceWrite?: boolean;
    /** Shared full-access grant as configured; see codingHarnessAccess for each harness's effective access. */
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

type PendingLocalTaskCompletion = {
  message: LocalTaskCompletedMessage;
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
};

type BackendErrorMessage = {
  type: "error";
  error_code?: string;
  message?: string;
  task_id?: string;
};

type CodingAgentCapabilityOptions = NonNullable<LocalRuntimeCapabilityOptions["codex"]>;

/**
 * Effective sandbox/permission access for one harness.
 *
 * With one harness enabled this is the previous single-provider behaviour:
 * the shared allowWorkspaceWrite/allowDangerFullAccess grants apply as given
 * (undefined stays undefined so adapters ask for approval). With several
 * harnesses enabled each harness gets access only from its own setting — the
 * default sandbox for Codex/Cursor/Antigravity, the permission mode for
 * Claude Code — and the shared grants widen nobody.
 */
export function codingHarnessAccess(
  provider: CodingAgentProvider,
  config: CodingAgentCapabilityOptions | undefined
): { allowWorkspaceWrite?: boolean; allowDangerFullAccess?: boolean } {
  if (!config || normalizeCodingAgentProviders(config.provider, config.providers).providers.length <= 1) {
    return { allowWorkspaceWrite: config?.allowWorkspaceWrite, allowDangerFullAccess: config?.allowDangerFullAccess };
  }
  if (provider === "claude-code") {
    const mode = config.claudePermissionMode;
    return {
      allowWorkspaceWrite: mode === "acceptEdits" || mode === "bypassPermissions",
      allowDangerFullAccess: mode === "bypassPermissions"
    };
  }
  const sandbox = config.defaultSandbox;
  return {
    allowWorkspaceWrite: sandbox === "workspace-write" || sandbox === "danger-full-access",
    allowDangerFullAccess: sandbox === "danger-full-access"
  };
}

type CodingHarnessAdapter = {
  adapter: CodingAgentAdapter;
  signature: string;
  retired: boolean;
  disposed: boolean;
  running: Set<string>;
  pendingStarts: number;
};

export type CodingAgentRouterOptions = {
  create: (provider: CodingAgentProvider, sessions: Map<string, CodingSessionState>) => CodingAgentAdapter;
  /** Settings fingerprint; a harness whose fingerprint changes gets a fresh adapter. */
  signature: (provider: CodingAgentProvider) => string;
  /** Resolves the project directory of a start_task call, for session lookup. */
  resolveProjectDirectory: (candidate?: string) => string;
  /** Task ids kept for status/output routing; older finished tasks are forgotten. */
  maxTrackedTasks?: number;
};

const DEFAULT_MAX_TRACKED_CODING_TASKS = 1_000;

/**
 * Runs each coding task on one of the enabled harnesses. Adapters are created
 * on first use. A harness that is disabled or reconfigured keeps its old
 * adapter alive until that adapter's running tasks finish; status, output and
 * cancel always reach the adapter that started the task. Resumable sessions
 * are kept per harness here and survive adapter rebuilds.
 */
export class CodingAgentRouter implements CodingAgentAdapter {
  private defaultProvider: CodingAgentProvider = "codex";
  private enabledProviders: CodingAgentProvider[] = ["codex"];
  private readonly options: CodingAgentRouterOptions;
  private readonly active = new Map<CodingAgentProvider, CodingHarnessAdapter>();
  private readonly sessions = new Map<CodingAgentProvider, Map<string, CodingSessionState>>();
  private readonly tasks = new Map<string, CodingHarnessAdapter>();
  private readonly finishedBeforeStart = new Set<string>();
  private readonly undisposed = new Set<CodingHarnessAdapter>();
  private disposed = false;

  constructor(options: CodingAgentRouterOptions) {
    this.options = options;
  }

  get provider(): CodingAgentProvider {
    return this.defaultProvider;
  }

  get providers(): CodingAgentProvider[] {
    return [...this.enabledProviders];
  }

  configure(provider: CodingAgentProvider | undefined, providers: CodingAgentProvider[] | undefined): void {
    const normalized = normalizeCodingAgentProviders(provider, providers);
    this.defaultProvider = normalized.provider;
    this.enabledProviders = normalized.providers;
    for (const [harnessProvider, harness] of [...this.active]) {
      if (!this.enabledProviders.includes(harnessProvider) || harness.signature !== this.options.signature(harnessProvider)) {
        this.active.delete(harnessProvider);
        harness.retired = true;
        this.disposeIfIdle(harness);
      }
    }
  }

  async startTask(args: JsonObject, context: ToolExecutionContext): Promise<JsonObject> {
    if (this.disposed) {
      throw new Error("The local runtime is stopping and cannot start another coding task.");
    }
    const target = this.resolveTarget(args, context);
    const harness = this.harness(target.provider);
    harness.pendingStarts += 1;
    let result: JsonObject;
    try {
      result = await harness.adapter.startTask(args, context);
    } catch (error: unknown) {
      harness.pendingStarts -= 1;
      this.startsSettled();
      this.disposeIfIdle(harness);
      throw error;
    }
    harness.pendingStarts -= 1;
    const taskId = typeof result.task_id === "string" ? result.task_id : "";
    if (this.disposed) {
      if (taskId) {
        await harness.adapter.cancel(taskId);
      }
      await harness.adapter.dispose?.();
      throw new Error("The local runtime stopped before the coding task could start.");
    }
    if (taskId) {
      const finishedEarly = this.finishedBeforeStart.delete(taskId);
      if (result.status === "running" && !finishedEarly) {
        harness.running.add(taskId);
      }
      this.trackTask(taskId, harness);
    }
    this.startsSettled();
    this.disposeIfIdle(harness);
    return target.warning ? { ...result, session_warning: target.warning } : result;
  }

  /** Called when a task reaches a terminal state, so a retired adapter can be released. */
  taskFinished(taskId: string): void {
    if (this.disposed) {
      return;
    }
    const harness = this.tasks.get(taskId);
    if (!harness) {
      // The adapter reported the end before startTask returned the task id.
      this.finishedBeforeStart.add(taskId);
      return;
    }
    harness.running.delete(taskId);
    this.disposeIfIdle(harness);
  }

  async getStatus(taskId: string): Promise<JsonObject> {
    return this.taskAdapter(taskId).getStatus(taskId);
  }

  async getOutput(taskId: string, args?: JsonObject): Promise<JsonObject> {
    return this.taskAdapter(taskId).getOutput(taskId, args);
  }

  async cancel(taskId: string): Promise<JsonObject> {
    return this.taskAdapter(taskId).cancel(taskId);
  }

  // Intentionally not called from LocalRuntimeDaemon.stop() in this repo (stop never cancelled coding tasks; the desktop app kills the daemon process).
  async dispose(): Promise<void> {
    this.disposed = true;
    const tasks = [...this.tasks.entries()];
    this.tasks.clear();
    await Promise.all(tasks.map(([taskId, harness]) => harness.adapter.cancel(taskId)));
    const harnesses = [...this.undisposed];
    this.undisposed.clear();
    this.active.clear();
    this.finishedBeforeStart.clear();
    await Promise.all(harnesses.map(harness => {
      harness.disposed = true;
      return harness.adapter.dispose?.();
    }));
  }

  private resolveTarget(
    args: JsonObject,
    context: ToolExecutionContext
  ): { provider: CodingAgentProvider; warning?: string } {
    const requested = args.provider;
    let explicit: CodingAgentProvider | undefined;
    if (requested !== undefined && requested !== null && requested !== "") {
      if (!isCodingAgentProvider(requested)) {
        throw new ToolExecutionError(
          "invalid_arguments",
          `provider must be one of ${CODING_AGENT_PROVIDERS.join(", ")}. Enabled coding harnesses: ${this.enabledProviders.join(", ")}.`,
          { enabled_providers: this.enabledProviders, default_provider: this.defaultProvider }
        );
      }
      if (!this.enabledProviders.includes(requested)) {
        throw new ToolExecutionError(
          "invalid_arguments",
          `The ${requested} coding harness is not enabled on this computer. Enabled coding harnesses: ${this.enabledProviders.join(", ")} (default: ${this.defaultProvider}).`,
          { provider: requested, enabled_providers: this.enabledProviders, default_provider: this.defaultProvider }
        );
      }
      explicit = requested;
    }
    const owner = this.sessionOwner(args, context);
    if (owner && !this.enabledProviders.includes(owner.provider)) {
      if (stringArg(args, "provider_session_id")) {
        throw new ToolExecutionError(
          "invalid_arguments",
          `This coding session belongs to the ${owner.provider} harness, which is not enabled on this computer. Enabled coding harnesses: ${this.enabledProviders.join(", ")}.`,
          { provider: owner.provider, enabled_providers: this.enabledProviders, default_provider: this.defaultProvider }
        );
      }
      // The latest session for this agent/project ran on a harness that is
      // not available now (switched by an older backend, disabled, or not
      // installed). Start fresh, as before multi-harness support, instead of
      // resuming an older session another harness kept under the same key.
      const provider = explicit ?? this.defaultProvider;
      this.sessions.get(provider)?.delete(owner.sessionKey);
      return {
        provider,
        warning: `The previous coding session for this project belonged to the ${owner.provider} harness, which is not enabled on this computer; started a new ${provider} session instead.`
      };
    }
    // Sessions no harness knows (e.g. a provider_session_id from before a
    // restart) continue on the default harness, as before.
    return { provider: explicit ?? owner?.provider ?? this.defaultProvider };
  }

  /** The harness, enabled or not, holding the most recent stored session this task would continue. */
  private sessionOwner(
    args: JsonObject,
    context: ToolExecutionContext
  ): { provider: CodingAgentProvider; sessionKey: string } | undefined {
    if (args.continue_session !== true) {
      return undefined;
    }
    let cwd: string | undefined;
    const resolveCwd = () => {
      cwd ??= this.options.resolveProjectDirectory(stringArg(args, "project") || stringArg(args, "cwd"));
      return cwd;
    };
    let owner: { provider: CodingAgentProvider; sessionKey: string } | undefined;
    let ownerUpdatedAt = "";
    for (const [provider, sessions] of this.sessions) {
      const match = findStoredCodingSession(args, context, resolveCwd, sessions);
      if (match && (owner === undefined || match.updated_at > ownerUpdatedAt)) {
        owner = { provider, sessionKey: match.session_key };
        ownerUpdatedAt = match.updated_at;
      }
    }
    return owner;
  }

  private harness(provider: CodingAgentProvider): CodingHarnessAdapter {
    const existing = this.active.get(provider);
    if (existing) {
      return existing;
    }
    let sessions = this.sessions.get(provider);
    if (!sessions) {
      sessions = new Map();
      this.sessions.set(provider, sessions);
    }
    const harness: CodingHarnessAdapter = {
      adapter: this.options.create(provider, sessions),
      signature: this.options.signature(provider),
      retired: false,
      disposed: false,
      running: new Set(),
      pendingStarts: 0
    };
    this.active.set(provider, harness);
    this.undisposed.add(harness);
    return harness;
  }

  private taskAdapter(taskId: string): CodingAgentAdapter {
    const harness = this.tasks.get(taskId);
    if (!harness) {
      throw new ToolExecutionError("not_found", `Unknown coding task: ${taskId}`, { task_id: taskId });
    }
    return harness.adapter;
  }

  private trackTask(taskId: string, harness: CodingHarnessAdapter): void {
    this.tasks.set(taskId, harness);
    const limit = this.options.maxTrackedTasks ?? DEFAULT_MAX_TRACKED_CODING_TASKS;
    // Forget the oldest finished tasks; running tasks stay reachable.
    for (const [trackedId, tracked] of this.tasks) {
      if (this.tasks.size <= limit) {
        break;
      }
      if (!tracked.running.has(trackedId)) {
        this.tasks.delete(trackedId);
      }
    }
  }

  private startsSettled(): void {
    // Early terminal notices only matter while a start is still awaiting.
    if ([...this.undisposed].every(harness => harness.pendingStarts === 0)) {
      this.finishedBeforeStart.clear();
    }
  }

  private disposeIfIdle(harness: CodingHarnessAdapter): void {
    if (!harness.retired || harness.disposed || harness.running.size > 0 || harness.pendingStarts > 0) {
      return;
    }
    harness.disposed = true;
    this.undisposed.delete(harness);
    // The adapter stays reachable through `tasks` for status/output of its finished tasks.
    harness.adapter.dispose?.().catch(() => undefined);
  }
}

const LOCAL_TASK_COMPLETION_RETRY_DELAYS_MS = [1_000, 3_000, 10_000];
const LOCAL_TASK_COMPLETION_RETENTION_MS = 2 * 60_000;
const DEFAULT_CONNECTION_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
const CONNECTION_REFRESH_APPROVAL_DELAY_MS = 60_000;

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
  private connectionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRuntimeMessageAtMs = 0;
  private readonly pendingRuntimeMessages: RuntimeMessage[] = [];
  private readonly pendingApprovalRequests = new Map<string, PendingApprovalRequest>();
  private readonly pendingLocalTaskCompletions = new Map<string, PendingLocalTaskCompletion>();
  private browserDebugAdapter: BrowserDebugAdapter | null = null;
  private filesystemMcpClient: FilesystemMcpClient | null = null;
  private codingAgentAdapter: CodingAgentRouter | null = null;
  private codingAgentTools: CodingAgentTools | null = null;

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
      this.stopConnectionRefresh();
    });
    await this.websocket.start();
  }

  async stop(): Promise<void> {
    await this.websocket.stop();
    this.stopHeartbeat();
    this.stopConnectionRefresh();
    this.leaseManager.clearActiveLease();
    this.rejectPendingApprovalRequests("Daemon stopped before approval response");
    this.clearPendingLocalTaskCompletions();
    await Promise.all([
      this.browserAdapter?.dispose?.(),
      this.browserDebugAdapter?.dispose?.(),
      this.filesystemMcpClient?.dispose?.()
    ]);
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
      this.startConnectionRefresh();
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
      await this.persistAgentsSync(message);
      return;
    }

    if (isHeartbeatAckMessage(message)) {
      return;
    }

    if (isBackendErrorMessage(message)) {
      this.handleBackendError(message);
      return;
    }

    if (isApprovalResponseMessage(message)) {
      this.resolveApprovalResponse(message);
      return;
    }

    if (isControlRequestMessage(message)) {
      this.sendRuntimeMessage(await this.handleControlRequest(message));
      return;
    }

    if (isToolCallMessage(message)) {
      const runContext = toolCallRunContext(message);
      const toolArguments = toolCallArguments(message);
      const result = await withBackendAuthorizedDirectories(
        message.authorized_directories ?? [],
        () => this.registry.execute(message, this.leaseManager)
      );
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
    const capabilities = this.capabilityPayload();
    const message = {
      type: "hello",
      platform: process.platform,
      daemon_version: this.options.daemonVersion ?? "0.1.37",
      capabilities
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

  private startConnectionRefresh(): void {
    const intervalMs = this.connectionRefreshIntervalMs();
    if (intervalMs <= 0) {
      return;
    }
    this.scheduleConnectionRefresh(intervalMs);
  }

  private scheduleConnectionRefresh(delayMs: number): void {
    this.stopConnectionRefresh();
    this.connectionRefreshTimer = setTimeout(() => this.refreshConnection(), delayMs);
  }

  private stopConnectionRefresh(): void {
    if (!this.connectionRefreshTimer) {
      return;
    }
    clearTimeout(this.connectionRefreshTimer);
    this.connectionRefreshTimer = null;
  }

  private refreshConnection(): void {
    this.connectionRefreshTimer = null;
    const intervalMs = this.connectionRefreshIntervalMs();
    if (intervalMs <= 0) {
      return;
    }

    if (this.pendingApprovalRequests.size > 0) {
      this.logger.info("delaying scheduled local runtime websocket refresh until approvals complete", {
        pendingApprovals: this.pendingApprovalRequests.size
      });
      this.scheduleConnectionRefresh(CONNECTION_REFRESH_APPROVAL_DELAY_MS);
      return;
    }

    this.logger.info("refreshing local runtime websocket connection", {
      intervalMs
    });
    this.websocket.reconnect();
  }

  private connectionRefreshIntervalMs(): number {
    const intervalMs = this.options.connectionRefreshIntervalMs ?? DEFAULT_CONNECTION_REFRESH_INTERVAL_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return 0;
    }
    return intervalMs;
  }

  private async persistAgentsSync(message: AgentsSyncMessage): Promise<void> {
    if (!this.options.agentsSyncPath) {
      return;
    }

    try {
      await saveAgentsSyncSnapshot(this.options.agentsSyncPath, message);
      this.logger.info("saved local runtime agents sync", {
        path: this.options.agentsSyncPath,
        agentCount: message.agents.length
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn("failed to save local runtime agents sync", {
        path: this.options.agentsSyncPath,
        error: detail
      });
    }
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
        capabilities: this.capabilityPayload()
      }, { queueOnFailure: false });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn("failed to send local runtime heartbeat", { error: detail });
    }
  }

  private capabilityPayload(): {
    tools: ReturnType<ToolRegistry["capabilities"]>;
    settings: RuntimeCapabilitySettings;
  } {
    return {
      tools: this.registry.capabilities(),
      settings: {
        browser: {
          provider: this.options.browserProvider ?? "managed",
          channel: this.options.browserChannel ?? "chrome",
          remember_session: this.options.browserRememberSession !== false,
          headless: this.options.browserHeadless === true
        },
        coding_agent: {
          enabled: this.codingAgentEnabled(),
          ...this.runnableCodingProviders(),
          sandbox: this.options.capabilities?.codex?.defaultSandbox ?? "read-only"
        },
        shell: {
          default_access: this.options.capabilities?.shell?.defaultAccess ?? "read-only",
          write_enabled:
            this.options.capabilities?.shell?.allowWorkspaceWrite === true ||
            this.options.capabilities?.shell?.allowDangerFullAccess === true
        }
      }
    };
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
        cwd: task.cwd,
        git_branch: task.git_branch ?? null
      },
      result: {
        final_message: task.final_message,
        exit_code: task.exit_code,
        git_branch: task.git_branch ?? null,
        blocked_reason: task.blocked_reason ?? null,
        progress_update: task.progress_update || null,
        output_tail: tailText(task.output || task.stderr || task.stdout)
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
        git_branch: task.git_branch ?? null,
        blocked_reason: task.blocked_reason ?? null,
        progress_update: task.progress_update || null,
        output_tail: tailText(task.output || task.stderr || task.stdout),
        provider_session_id: task.provider_session_id ?? null,
        codex_thread_id: task.codex_thread_id ?? null,
        claude_session_id: task.claude_session_id ?? null,
        antigravity_conversation_id: task.antigravity_conversation_id ?? null,
        cursor_chat_id: task.cursor_chat_id ?? null
      }
    };
    this.sendLocalTaskCompletion(message);
  }

  private sendCodingTaskEvent(task: CodingTask, event: CodingTaskEvent, text: string): void {
    const normalizedEvent: JsonObject = {
      index: event.index,
      at: event.at,
      source: event.source,
      type: event.type,
      item_type: codingTaskEventItemType(event),
      text
    };
    if (event.actions?.length) {
      normalizedEvent.actions = event.actions as unknown as JsonValue;
    }

    const message: LocalTaskEventMessage = {
      type: "local_task_event",
      request_id: task.request_id,
      tool: "coding_agent.start_task",
      agent_id: task.agent_id,
      event_run_id: task.event_run_id ?? task.local_task_id,
      task_id: task.task_id,
      local_task_id: task.task_id,
      task: {
        provider: task.provider,
        status: task.status,
        cwd: task.cwd,
        git_branch: task.git_branch ?? null,
        model: task.model ?? null,
        progress_update: task.progress_update ?? null,
        final_message: task.final_message,
        blocked_reason: task.blocked_reason ?? null,
        provider_session_id: task.provider_session_id ?? null,
        codex_thread_id: task.codex_thread_id ?? null,
        claude_session_id: task.claude_session_id ?? null,
        antigravity_conversation_id: task.antigravity_conversation_id ?? null,
        cursor_chat_id: task.cursor_chat_id ?? null
      },
      event: normalizedEvent
    };

    try {
      this.sendRuntimeMessage(message, { queueOnFailure: false });
    } catch (error: unknown) {
      this.logger.debug("skipped live coding event while websocket is unavailable", {
        taskId: task.task_id,
        eventIndex: event.index,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private handleBackendError(message: BackendErrorMessage): void {
    if (message.error_code === "not_found" && message.task_id && this.retryLocalTaskCompletion(message.task_id)) {
      return;
    }

    this.logger.warn("local runtime backend error", {
      errorCode: message.error_code,
      backendMessage: message.message,
      taskId: message.task_id
    });
  }

  private sendLocalTaskCompletion(message: LocalTaskCompletedMessage): void {
    let pending = this.pendingLocalTaskCompletions.get(message.task_id);
    if (!pending) {
      pending = {
        message,
        retryCount: 0,
        retryTimer: null,
        cleanupTimer: null
      };
      this.pendingLocalTaskCompletions.set(message.task_id, pending);
    } else {
      pending.message = message;
    }

    this.scheduleLocalTaskCompletionCleanup(message.task_id, pending);
    this.logger.info("sending local coding task completion", {
      taskId: message.task_id,
      requestId: message.request_id,
      status: message.status,
      retryCount: pending.retryCount
    });
    this.sendRuntimeMessage(message);
  }

  private retryLocalTaskCompletion(taskId: string): boolean {
    const pending = this.pendingLocalTaskCompletions.get(taskId);
    if (!pending) {
      return false;
    }

    if (pending.retryTimer) {
      return true;
    }

    const retryDelayMs = LOCAL_TASK_COMPLETION_RETRY_DELAYS_MS[pending.retryCount];
    if (retryDelayMs === undefined) {
      this.pendingLocalTaskCompletions.delete(taskId);
      this.clearLocalTaskCompletionTimers(pending);
      this.logger.warn("local coding task completion was rejected after retries", {
        taskId,
        attempts: pending.retryCount + 1
      });
      return true;
    }

    pending.retryCount += 1;
    this.scheduleLocalTaskCompletionCleanup(taskId, pending);
    this.logger.warn("backend has not recorded local coding task yet; retrying completion", {
      taskId,
      retryInMs: retryDelayMs,
      attempt: pending.retryCount
    });
    pending.retryTimer = setTimeout(() => {
      pending.retryTimer = null;
      this.logger.info("retrying local coding task completion", {
        taskId,
        attempt: pending.retryCount
      });
      this.sendRuntimeMessage(pending.message);
    }, retryDelayMs);
    pending.retryTimer.unref?.();
    return true;
  }

  private scheduleLocalTaskCompletionCleanup(taskId: string, pending: PendingLocalTaskCompletion): void {
    if (pending.cleanupTimer) {
      clearTimeout(pending.cleanupTimer);
    }
    pending.cleanupTimer = setTimeout(() => {
      this.pendingLocalTaskCompletions.delete(taskId);
      this.clearLocalTaskCompletionTimers(pending);
    }, LOCAL_TASK_COMPLETION_RETENTION_MS);
    pending.cleanupTimer.unref?.();
  }

  private clearPendingLocalTaskCompletions(): void {
    for (const pending of this.pendingLocalTaskCompletions.values()) {
      this.clearLocalTaskCompletionTimers(pending);
    }
    this.pendingLocalTaskCompletions.clear();
  }

  private clearLocalTaskCompletionTimers(pending: PendingLocalTaskCompletion): void {
    if (pending.retryTimer) {
      clearTimeout(pending.retryTimer);
      pending.retryTimer = null;
    }
    if (pending.cleanupTimer) {
      clearTimeout(pending.cleanupTimer);
      pending.cleanupTimer = null;
    }
  }

  private async handleControlRequest(message: ControlRequestMessage): Promise<ControlResultMessage> {
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

      case "get_coding_agent_config":
        if (!this.options.codingAgentConfiguration) {
          return errorControlResult(
            message.request_id,
            "unknown_message",
            "This connector does not support remote coding-agent configuration."
          );
        }
        try {
          return okControlResult(
            message.request_id,
            withDetectedCodingAgents({
              ...(await this.options.codingAgentConfiguration.get()),
              // The effective on/off state, the same value the heartbeat reports.
              enabled: this.codingAgentEnabled()
            })
          );
        } catch (error: unknown) {
          return errorControlResult(
            message.request_id,
            "tool_failed",
            error instanceof Error ? error.message : String(error)
          );
        }

      case "set_coding_agent_config":
        if (!this.options.codingAgentConfiguration) {
          return errorControlResult(
            message.request_id,
            "unknown_message",
            "This connector does not support remote coding-agent configuration."
          );
        }
        try {
          // `detected` and `grant_rules` are read-only; a client echoing them back must not store them.
          const input: JsonObject = { ...args };
          delete input.detected;
          delete input.grant_rules;
          // Only an explicit `enabled` switches coding on or off; any other
          // change (a model, a harness) keeps the current state.
          if (!Object.prototype.hasOwnProperty.call(input, "enabled")) {
            input.enabled = this.codingAgentEnabled();
          }
          const saved = await this.options.codingAgentConfiguration.set(input);
          this.applyCodingAgentConfiguration(saved);
          this.sendHeartbeat();
          return okControlResult(
            message.request_id,
            withDetectedCodingAgents({ ...saved, enabled: this.codingAgentEnabled() })
          );
        } catch (error: unknown) {
          return errorControlResult(
            message.request_id,
            "invalid_arguments",
            error instanceof Error ? error.message : String(error)
          );
        }

      default:
        return errorControlResult(message.request_id, "unknown_message", `Unknown control action: ${message.action}`);
    }
  }

  private registerTools(): void {
    const workspacePolicy = new WorkspacePolicy({
      allowedDirectories: this.options.allowedDirectories,
      allowedFileDirectories: [os.tmpdir(), "/tmp"]
    });
    const approvalProvider = this.createApprovalProvider();
    const browserAdapter: BrowserAdapter =
      this.options.browserProvider === "mcp-chrome"
        ? new McpChromeBrowserAdapter({
            endpointUrl: this.options.browserMcpUrl
          })
        : new AgentScopedManagedBrowserAdapter({
            userDataDir: this.options.browserProfileDir,
            rememberSession: this.options.browserRememberSession,
            headless: this.options.browserHeadless,
            browserChannel: this.options.browserChannel,
            viewport: this.options.browserViewport
    });
    this.browserAdapter = browserAdapter;
    if (browserAdapter.stagehand) {
      const nativeStagehand = browserAdapter.stagehand.bind(browserAdapter);
      const relay = new URL(this.options.wsUrl);
      relay.protocol = relay.protocol === "wss:" ? "https:" : "http:";
      relay.pathname = "/api/v1/integrations/local-runtime/stagehand/";
      relay.search = ""; relay.hash = "";
      browserAdapter.stagehand = (args, context) => nativeStagehand(args, { ...context!, stagehandRelayUrl: relay.toString() });
    }
    const browserTools = new BrowserTools(browserAdapter, {
      resolveFilePath: (filePath) => workspacePolicy.resolveAllowedFile(filePath)
    });
    const workspaceTools = new WorkspaceTools(workspacePolicy);
    const filesystemMcpClient = new OfficialFilesystemMcpClient({
      allowedDirectories: () => workspacePolicy.listAllowedDirectories()
    });
    this.filesystemMcpClient = filesystemMcpClient;
    const filesystemTools = new FilesystemTools({
      workspacePolicy,
      client: filesystemMcpClient
    });
    const shellTools = new ShellTools({
      workspacePolicy,
      approvalProvider,
      defaultAccess: this.options.capabilities?.shell?.defaultAccess,
      allowWorkspaceWrite: this.options.capabilities?.shell?.allowWorkspaceWrite,
      allowDangerFullAccess: this.options.capabilities?.shell?.allowDangerFullAccess,
      defaultTimeoutMs: this.options.capabilities?.shell?.defaultTimeoutMs,
      defaultMaxOutputBytes: this.options.capabilities?.shell?.defaultMaxOutputBytes,
      shell: this.options.capabilities?.shell?.shell
    });
    this.codingAgentAdapter = new CodingAgentRouter({
      create: (provider, sessions) => this.createCodingAgentAdapter(provider, sessions),
      signature: provider => JSON.stringify(codingHarnessSettings(provider, this.options.capabilities?.codex)),
      resolveProjectDirectory: candidate => workspacePolicy.resolveProjectDirectory(candidate)
    });
    const enabledCoding = this.runnableCodingProviders();
    this.codingAgentAdapter.configure(enabledCoding.provider, enabledCoding.providers);
    const codingAgentTools = new CodingAgentTools(this.codingAgentAdapter);
    this.codingAgentTools = codingAgentTools;
    const gitTools = new GitTools({ workspacePolicy, approvalProvider });
    const browserDebugConfig = this.options.capabilities?.browserDebug;

    if (this.options.capabilities?.browser?.enabled !== false) {
      for (const definition of browserTools.definitions()) {
        this.registry.register(definition);
      }
    }
    if (browserDebugConfig?.enabled === true) {
      const browserDebugAdapter = new ChromeDevToolsBrowserDebugAdapter({
        command: browserDebugConfig.command,
        args: browserDebugConfig.args,
        browserUrl: browserDebugConfig.browserUrl
      });
      this.browserDebugAdapter = browserDebugAdapter;
      for (const definition of new BrowserDebugTools(browserDebugAdapter).definitions()) {
        this.registry.register(definition);
      }
    }
    if (this.options.capabilities?.workspace?.enabled !== false) {
      for (const definition of workspaceTools.definitions()) {
        this.registry.register(definition);
      }
      for (const definition of filesystemTools.definitions()) {
        this.registry.register(definition);
      }
    }
    if (this.options.capabilities?.shell?.enabled === true) {
      for (const definition of shellTools.definitions()) {
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

  private applyCodingAgentConfiguration(config: JsonObject): void {
    const { provider, providers } = normalizeCodingAgentProviders(config.provider, config.providers);
    const defaultSandbox = codingAgentSandboxArg(config.default_sandbox);
    const reasoningEffort = codexReasoningEffortArg(config.reasoning_effort);
    const claudeReasoningEffort = claudeReasoningEffortArg(config.claude_reasoning_effort);
    const claudePermissionMode = claudePermissionModeArg(config.claude_permission_mode);
    const cursorModel = selectedCodingAgentModel(
      config.cursor_model,
      config.cursor_model_custom
    );
    const claudeModel = selectedCodingAgentModel(
      config.claude_model,
      config.claude_model_custom
    );
    const nextConfig: NonNullable<LocalRuntimeCapabilityOptions["codex"]> = {
      enabled: config.enabled !== false,
      provider,
      providers,
      command: stringValue(config.command),
      model: stringValue(config.model),
      reasoningEffort,
      antigravityCommand: stringValue(config.antigravity_command),
      antigravityModel: stringValue(config.antigravity_model),
      antigravityReasoningEffort: antigravityReasoningEffortArg(config.antigravity_reasoning_effort),
      cursorCommand: stringValue(config.cursor_command),
      cursorModel,
      claudeCommand: stringValue(config.claude_command),
      claudeModel,
      claudeReasoningEffort,
      claudePermissionMode,
      defaultSandbox,
      allowWorkspaceWrite: config.allow_workspace_write === true,
      allowDangerFullAccess: config.allow_danger_full_access === true
    };
    this.options.capabilities ??= {};
    this.options.capabilities.codex = nextConfig;
    // Harnesses whose settings changed or that were disabled get retired;
    // their running tasks finish on the old adapter.
    const runnable = this.runnableCodingProviders();
    this.codingAgentAdapter?.configure(runnable.provider, runnable.providers);

    const definitions = this.codingAgentTools?.definitions() ?? [];
    if (nextConfig.enabled !== false) {
      for (const definition of definitions) {
        if (!this.registry.has(definition.name)) {
          this.registry.register(definition);
        }
      }
      return;
    }
    for (const definition of definitions) {
      this.registry.unregister(definition.name);
    }
  }

  /** Whether coding-agent tools are on; the heartbeat's `coding_agent.enabled`. */
  private codingAgentEnabled(): boolean {
    return this.options.capabilities?.codex?.enabled !== false;
  }

  /**
   * The configured harnesses minus non-default ones the host reported as not
   * installed for this run. Adapter access still follows the configured list.
   */
  private runnableCodingProviders(): { provider: CodingAgentProvider; providers: CodingAgentProvider[] } {
    const configured = normalizeCodingAgentProviders(
      this.options.capabilities?.codex?.provider,
      this.options.capabilities?.codex?.providers
    );
    const unavailable = this.options.unavailableCodingProviders ?? [];
    return {
      provider: configured.provider,
      providers: configured.providers.filter(provider => provider === configured.provider || !unavailable.includes(provider))
    };
  }

  private createApprovalProvider(): ApprovalProvider {
    if (this.options.interactiveApprovals === false) {
      return createDefaultApprovalProvider(false);
    }

    const websocketProvider = new WebSocketApprovalProvider((message) => this.sendApprovalRequest(message));
    if (this.options.interactiveApprovals === true || process.stdin.isTTY === true) {
      const localProvider = createDefaultApprovalProvider(true);
      return {
        requestApproval: (request: ApprovalRequest) => (
          typeof request.metadata?.approval_token === "string"
            ? websocketProvider.requestApproval(request)
            : localProvider.requestApproval(request)
        )
      };
    }

    return websocketProvider;
  }

  private createCodingAgentAdapter(
    provider: CodingAgentProvider,
    sessions: Map<string, CodingSessionState>
  ): CodingAgentAdapter {
    const workspacePolicy = new WorkspacePolicy({
      allowedDirectories: this.options.allowedDirectories,
      allowedFileDirectories: [os.tmpdir(), "/tmp"]
    });
    const approvalProvider = this.createApprovalProvider();
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
        const metadata: JsonObject = {
          local_task_id: task.task_id,
          provider: task.provider,
          status: task.status,
          cwd: task.cwd,
          git_branch: task.git_branch ?? null,
          event_index: event.index,
          event_type: event.type,
          event_item_type: codingTaskEventItemType(event),
          source: event.source
        };
        const result: JsonObject = {
          text: text ?? processEventLabel(event),
          event_type: event.type
        };
        if (event.actions?.length) {
          const actions = event.actions as unknown as JsonValue;
          metadata.coding_actions = actions;
          result.coding_actions = actions;
        }
        this.auditLogger.record({
          at: event.at,
          event: "coding_task_event",
          requestId: task.request_id,
          agentId: task.agent_id,
          taskId: task.local_task_id,
          eventRunId: task.event_run_id,
          tool: "coding_agent.start_task",
          metadata,
          result
        });
        this.sendCodingTaskEvent(task, event, text ?? processEventLabel(event));
      },
      onTaskTerminal: (task: CodingTask) => {
        if (task.lease_id) {
          this.leaseManager.releaseLease(task.lease_id);
        }
        this.sendCodingTaskCompletion(task);
        this.codingAgentAdapter?.taskFinished(task.task_id);
      }
    };
    const settings = codingHarnessSettings(provider, this.options.capabilities?.codex);
    if (provider === "claude-code") {
      return new ClaudeCodeAdapter({
        workspacePolicy,
        approvalProvider,
        sessions,
        command: settings.command,
        defaultModel: settings.model,
        defaultReasoningEffort: settings.claudeReasoningEffort,
        permissionMode: settings.permissionMode,
        allowWorkspaceWrite: settings.allowWorkspaceWrite,
        allowBypassPermissions: settings.allowDangerFullAccess,
        ...callbacks
      });
    }

    if (provider === "antigravity") {
      return new AntigravityCliAdapter({
        workspacePolicy,
        approvalProvider,
        sessions,
        command: settings.command,
        defaultModel: settings.model,
        defaultReasoningEffort: settings.antigravityReasoningEffort,
        defaultSandbox: settings.defaultSandbox,
        allowWorkspaceWrite: settings.allowWorkspaceWrite,
        allowDangerFullAccess: settings.allowDangerFullAccess,
        ...callbacks
      });
    }

    if (provider === "cursor") {
      return new CursorCliAdapter({
        workspacePolicy,
        approvalProvider,
        sessions,
        command: settings.command,
        defaultModel: settings.model,
        defaultSandbox: settings.defaultSandbox,
        allowWorkspaceWrite: settings.allowWorkspaceWrite,
        allowDangerFullAccess: settings.allowDangerFullAccess,
        ...callbacks
      });
    }

    return new CodexCliAdapter({
      workspacePolicy,
      approvalProvider,
      sessions,
      command: settings.command,
      defaultModel: settings.model,
      defaultReasoningEffort: settings.reasoningEffort,
      defaultSandbox: settings.defaultSandbox,
      allowWorkspaceWrite: settings.allowWorkspaceWrite,
      allowDangerFullAccess: settings.allowDangerFullAccess,
      ...callbacks
    });
  }

  private gitToolEnabled(toolName: string): boolean {
    if (
      toolName === "git.status" ||
      toolName === "git.diff" ||
      toolName === "git.list_branches"
    ) {
      return this.options.capabilities?.git?.readEnabled !== false;
    }

    if (
      toolName === "git.checkout" ||
      toolName === "git.commit" ||
      toolName === "git.push" ||
      toolName === "git.pull" ||
      toolName === "git.abort_pull"
    ) {
      return this.options.capabilities?.git?.writeEnabled !== false;
    }

    return true;
  }
}

type CodingHarnessSettings = {
  command?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  claudeReasoningEffort?: ClaudeCodeReasoningEffort;
  antigravityReasoningEffort?: AntigravityReasoningEffort;
  permissionMode?: ClaudeCodePermissionMode;
  defaultSandbox?: CodexSandbox;
  allowWorkspaceWrite?: boolean;
  allowDangerFullAccess?: boolean;
};

/** The settings one harness's adapter is built from; nothing from other harnesses. */
function codingHarnessSettings(
  provider: CodingAgentProvider,
  config: CodingAgentCapabilityOptions | undefined
): CodingHarnessSettings {
  const access = codingHarnessAccess(provider, config);
  if (provider === "claude-code") {
    return {
      command: codingAgentCommand("claude-code", config?.claudeCommand),
      model: config?.claudeModel,
      claudeReasoningEffort: config?.claudeReasoningEffort,
      permissionMode: config?.claudePermissionMode,
      ...access
    };
  }
  if (provider === "antigravity") {
    return {
      command: codingAgentCommand("antigravity", config?.antigravityCommand),
      model: config?.antigravityModel,
      antigravityReasoningEffort: config?.antigravityReasoningEffort,
      defaultSandbox: config?.defaultSandbox,
      ...access
    };
  }
  if (provider === "cursor") {
    return {
      command: codingAgentCommand("cursor", config?.cursorCommand),
      model: config?.cursorModel,
      defaultSandbox: config?.defaultSandbox,
      ...access
    };
  }
  return {
    command: codingAgentCommand("codex", config?.command),
    model: config?.model,
    reasoningEffort: config?.reasoningEffort,
    defaultSandbox: config?.defaultSandbox,
    ...access
  };
}

/**
 * Adds the read-only fields of a coding-agent config response: `detected`
 * (which harness commands resolve to an executable right now) and
 * `grant_rules` (CODING_AGENT_GRANT_RULES_VERSION). Computed fresh each time
 * and never stored.
 */
function withDetectedCodingAgents(config: JsonObject): JsonObject {
  return {
    ...config,
    detected: detectCodingAgents(config) as unknown as JsonValue,
    grant_rules: CODING_AGENT_GRANT_RULES_VERSION
  };
}

function stringArg(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function selectedCodingAgentModel(
  selected: JsonValue | undefined,
  custom: JsonValue | undefined
): string | undefined {
  return selected === "custom" ? stringValue(custom) : stringValue(selected);
}

function codingAgentSandboxArg(value: JsonValue | undefined): CodexSandbox {
  return value === "workspace-write" || value === "danger-full-access"
    ? value
    : "read-only";
}

function codexReasoningEffortArg(value: JsonValue | undefined): CodexReasoningEffort | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : undefined;
}

function claudeReasoningEffortArg(value: JsonValue | undefined): ClaudeCodeReasoningEffort | undefined {
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
    ? value
    : undefined;
}

function antigravityReasoningEffortArg(value: JsonValue | undefined): AntigravityReasoningEffort | undefined {
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
    ? value
    : undefined;
}

function claudePermissionModeArg(value: JsonValue | undefined): ClaudeCodePermissionMode {
  return value === "acceptEdits" ||
    value === "plan" ||
    value === "auto" ||
    value === "dontAsk" ||
    value === "bypassPermissions"
    ? value
    : "default";
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

function isBackendErrorMessage(value: unknown): value is BackendErrorMessage {
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
  const action = event.actions?.[0];
  if (action) {
    return tailText(action.detail || action.error || action.name, 4_000);
  }

  if (event.text?.trim()) {
    return tailText(event.text.trim(), 4_000);
  }

  const data = event.data;
  if (!data) {
    return undefined;
  }

  if (isJsonObject(data.item)) {
    const actionText = codingTaskItemActionText(data.item);
    if (actionText) {
      return tailText(actionText, 4_000);
    }
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
    const toolUse = data.message.content.find((part) => (
      isJsonObject(part) && part.type === "tool_use" && typeof part.name === "string"
    ));
    if (isJsonObject(toolUse) && typeof toolUse.name === "string") {
      return tailText(toolUse.name, 4_000);
    }

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

function codingTaskItemActionText(item: JsonObject): string | undefined {
  const itemType = typeof item.type === "string" ? item.type.toLowerCase() : "";

  if (itemType.includes("command")) {
    const command = item.command ?? item.cmd ?? item.shell_command;
    return typeof command === "string" && command.trim() ? command.trim() : undefined;
  }

  if (itemType.includes("file_change") || itemType.includes("file_edit")) {
    const path = item.path ?? item.file_path ?? item.filename;
    if (typeof path === "string" && path.trim()) {
      return path.trim();
    }

    if (Array.isArray(item.changes)) {
      const paths = item.changes
        .map((change) => {
          if (!isJsonObject(change)) return "";
          const changedPath = change.path ?? change.file_path ?? change.filename;
          return typeof changedPath === "string" ? changedPath.trim() : "";
        })
        .filter(Boolean);
      if (paths.length > 0) {
        return paths.join(", ");
      }
    }
  }

  if (itemType.includes("search")) {
    const query = item.query ?? item.text;
    return typeof query === "string" && query.trim() ? query.trim() : undefined;
  }

  if (itemType.includes("tool")) {
    const toolName = item.name ?? item.tool_name ?? item.tool;
    return typeof toolName === "string" && toolName.trim() ? toolName.trim() : undefined;
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
