import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import type { ActiveLease, DaemonStatus, JsonObject } from "@clero-local-agent/protocol";
import type { EnsureLeaseForToolCallInput, EnsureLeaseForToolCallResult } from "@clero-local-agent/mcp-runtime";
import { AgentSessionRegistry } from "./agent-sessions.ts";

export type LeaseManagerOptions = {
  maxAgentSlots?: number;
  defaultTtlSeconds?: number;
  now?: () => number;
  leaseIdFactory?: () => string;
};

export type AcquireLeaseInput = {
  agentId: string;
  taskId: string;
  requestedTools: string[];
  workspaceKey?: string;
  ttlSeconds?: number;
};

type LeaseScope = string;

const BROWSER_SCOPE = "browser";
const WORKSPACE_SCOPE = "workspace";
const GLOBAL_SCOPE = "global";

export type AcquireLeaseResult =
  | { status: "granted"; lease: ActiveLease }
  | { status: "busy"; activeLease: ActiveLease }
  | { status: "slot_limit"; maxAgentSlots: number }
  | { status: "invalid_ttl"; message: string };

export type HeartbeatLeaseResult =
  | { status: "ok"; lease: ActiveLease }
  | { status: "not_found" }
  | { status: "expired" };

export type ReleaseLeaseResult = { status: "released" } | { status: "not_found" };

export class LeaseManager {
  private readonly maxAgentSlots: number;
  private readonly defaultTtlSeconds: number;
  private readonly now: () => number;
  private readonly leaseIdFactory: () => string;
  private readonly sessions: AgentSessionRegistry;
  private readonly activeLeases = new Map<LeaseScope, ActiveLease>();

  constructor(options: LeaseManagerOptions = {}) {
    this.maxAgentSlots = options.maxAgentSlots ?? 3;
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 60;
    this.now = options.now ?? Date.now;
    this.leaseIdFactory = options.leaseIdFactory ?? (() => `lease_${randomUUID()}`);
    this.sessions = new AgentSessionRegistry(this.maxAgentSlots, this.now);
  }

  acquireLease(input: AcquireLeaseInput): AcquireLeaseResult {
    const ttlSeconds = input.ttlSeconds ?? this.defaultTtlSeconds;
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      return { status: "invalid_ttl", message: "ttlSeconds must be a positive number" };
    }

    this.expireLeaseIfNeeded();
    const scope = leaseScopeForTools(input.requestedTools, input.workspaceKey);
    const activeLease = this.activeLeases.get(scope);
    if (activeLease) {
      if (activeLease.agent_id === input.agentId) {
        const refreshed = this.withScopeMetadata(
          {
            ...activeLease,
            task_id: input.taskId,
            requested_tools: input.requestedTools,
            expires_at: this.expiresAt(ttlSeconds)
          },
          scope
        );
        this.activeLeases.set(scope, refreshed);
        this.sessions.touch(input.agentId);
        return { status: "granted", lease: refreshed };
      }

      return { status: "busy", activeLease };
    }

    const registration = this.sessions.register(input.agentId);
    if (registration.status === "slot_limit") {
      return { status: "slot_limit", maxAgentSlots: registration.maxAgentSlots };
    }

    const lease = this.withScopeMetadata(
      {
        lease_id: this.leaseIdFactory(),
        agent_id: input.agentId,
        task_id: input.taskId,
        requested_tools: input.requestedTools,
        expires_at: this.expiresAt(ttlSeconds)
      },
      scope
    );
    this.activeLeases.set(scope, lease);

    return { status: "granted", lease };
  }

  heartbeatLease(leaseId: string, ttlSeconds = this.defaultTtlSeconds): HeartbeatLeaseResult {
    this.expireLeaseIfNeeded();
    const active = this.findLease(leaseId);
    if (!active) {
      return { status: "not_found" };
    }
    const { scope, lease } = active;

    if (this.isExpired(lease)) {
      this.activeLeases.delete(scope);
      this.unregisterAgentIfIdle(lease.agent_id);
      return { status: "expired" };
    }

    const refreshed = {
      ...lease,
      expires_at: this.expiresAt(ttlSeconds)
    };
    this.activeLeases.set(scope, refreshed);
    this.sessions.touch(refreshed.agent_id);
    return { status: "ok", lease: refreshed };
  }

  releaseLease(leaseId: string): ReleaseLeaseResult {
    this.expireLeaseIfNeeded();
    const active = this.findLease(leaseId);
    if (!active) {
      return { status: "not_found" };
    }

    this.activeLeases.delete(active.scope);
    this.unregisterAgentIfIdle(active.lease.agent_id);
    return { status: "released" };
  }

  hasActiveLease(leaseId: string): boolean {
    this.expireLeaseIfNeeded();
    return Boolean(this.findLease(leaseId));
  }

  ensureLeaseForToolCall(input: EnsureLeaseForToolCallInput): EnsureLeaseForToolCallResult {
    this.expireLeaseIfNeeded();

    if (input.leaseId && this.findLease(input.leaseId)) {
      const heartbeat = this.heartbeatLease(input.leaseId);
      if (heartbeat.status === "ok") {
        return { status: "ok", leaseId: heartbeat.lease.lease_id };
      }
    }

    const scope = leaseScopeForTools([input.requestedActionKey ?? input.toolName], input.workspaceKey);
    const activeLease = this.activeLeases.get(scope);
    if (activeLease) {
      const requestedAgentId = input.agentId;
      const sameOwner = requestedAgentId === activeLease.agent_id;

      if (sameOwner && !input.leaseId) {
        const refreshed = this.acquireLease({
          agentId: input.agentId ?? activeLease.agent_id,
          taskId: input.taskId ?? activeLease.task_id,
          requestedTools: [input.requestedActionKey ?? input.toolName],
          workspaceKey: input.workspaceKey
        });
        if (refreshed.status === "granted") {
          return { status: "ok", leaseId: refreshed.lease.lease_id };
        }
      }

      return {
        status: "error",
        errorCode: "busy",
        message: `${leaseScopeLabel(scope)} is busy.`,
        details: this.busyDetails(activeLease, scope)
      };
    }

    const agentId = input.agentId ?? "implicit_agent";
    const taskId = input.taskId ?? input.requestId;
    const acquired = this.acquireLease({
      agentId,
      taskId,
      requestedTools: [input.requestedActionKey ?? input.toolName],
      workspaceKey: input.workspaceKey
    });

    if (acquired.status === "granted") {
      return { status: "ok", leaseId: acquired.lease.lease_id };
    }

    if (acquired.status === "busy") {
      return {
        status: "error",
        errorCode: "busy",
        message: `${leaseScopeLabel(scope)} is busy.`,
        details: this.busyDetails(acquired.activeLease, scope)
      };
    }

    if (acquired.status === "slot_limit") {
      return {
        status: "error",
        errorCode: "slot_limit",
        message: "The local runtime already has a connected agent."
      };
    }

    return {
      status: "error",
      errorCode: "invalid_arguments",
      message: acquired.message
    };
  }

  getStatus(): DaemonStatus {
    this.expireLeaseIfNeeded();
    const activeLeases = [...this.activeLeases.values()];
    return {
      status: "online",
      max_agent_slots: this.maxAgentSlots,
      connected_agents: this.sessions.size(),
      active_lease: activeLeases[0] ?? null,
      active_leases: activeLeases
    };
  }

  registerAgent(agentId: string): boolean {
    return this.sessions.register(agentId).status !== "slot_limit";
  }

  unregisterAgent(agentId: string): void {
    for (const [scope, lease] of this.activeLeases) {
      if (lease.agent_id === agentId) {
        this.activeLeases.delete(scope);
      }
    }

    this.sessions.unregister(agentId);
  }

  clearActiveLease(): void {
    this.sessions.clear();
    this.activeLeases.clear();
  }

  private expireLeaseIfNeeded(): void {
    for (const [scope, lease] of this.activeLeases) {
      if (this.isExpired(lease)) {
        this.activeLeases.delete(scope);
        this.unregisterAgentIfIdle(lease.agent_id);
      }
    }
  }

  private isExpired(lease: ActiveLease): boolean {
    return Date.parse(lease.expires_at) <= this.now();
  }

  private expiresAt(ttlSeconds: number): string {
    return new Date(this.now() + ttlSeconds * 1000).toISOString();
  }

  private findLease(leaseId: string): { scope: LeaseScope; lease: ActiveLease } | undefined {
    for (const [scope, lease] of this.activeLeases) {
      if (lease.lease_id === leaseId) {
        return { scope, lease };
      }
    }
    return undefined;
  }

  private agentHasLease(agentId: string): boolean {
    return [...this.activeLeases.values()].some((lease) => lease.agent_id === agentId);
  }

  private unregisterAgentIfIdle(agentId: string): void {
    if (!this.agentHasLease(agentId)) {
      this.sessions.unregister(agentId);
    }
  }

  private busyDetails(lease: ActiveLease, scope: LeaseScope): JsonObject {
    const workspaceKey = workspaceKeyFromScope(scope);
    const activeLease: JsonObject = {
      agent_id: lease.agent_id,
      task_id: lease.task_id,
      expires_at: lease.expires_at
    };
    if (lease.workspace_key) {
      activeLease.workspace_key = lease.workspace_key;
    }

    return {
      lease_scope: leaseScopeKind(scope),
      ...(workspaceKey ? { workspace_key: workspaceKey } : {}),
      active_lease: activeLease
    };
  }

  private withScopeMetadata(lease: ActiveLease, scope: LeaseScope): ActiveLease {
    const workspaceKey = workspaceKeyFromScope(scope);
    if (!workspaceKey) {
      const { workspace_key: _workspaceKey, ...rest } = lease;
      return rest;
    }

    return {
      ...lease,
      workspace_key: workspaceKey
    };
  }
}

function leaseScopeForTools(tools: string[], workspaceKey?: string): LeaseScope {
  const scopes = new Set<LeaseScope>();
  for (const tool of tools) {
    scopes.add(leaseScopeForTool(tool, workspaceKey));
  }
  if (scopes.size === 1) {
    return [...scopes][0];
  }
  return GLOBAL_SCOPE;
}

function leaseScopeForTool(tool: string, workspaceKey?: string): LeaseScope {
  if (tool.includes(".browser") || tool.startsWith("browser.")) {
    return BROWSER_SCOPE;
  }
  if (tool.includes(".codex") || tool.startsWith("coding_agent.") || tool.startsWith("git.")) {
    return workspaceScope(workspaceKey);
  }
  return GLOBAL_SCOPE;
}

function leaseScopeLabel(scope: LeaseScope): string {
  const kind = leaseScopeKind(scope);
  if (kind === "browser") {
    return "Local browser";
  }
  if (kind === "workspace") {
    return "Local workspace";
  }
  return "Local runtime";
}

function workspaceScope(workspaceKey?: string): LeaseScope {
  return workspaceKey ? `${WORKSPACE_SCOPE}:${normalizeWorkspaceKey(workspaceKey)}` : WORKSPACE_SCOPE;
}

function leaseScopeKind(scope: LeaseScope): "browser" | "workspace" | "global" {
  if (scope === BROWSER_SCOPE) {
    return "browser";
  }
  if (scope === WORKSPACE_SCOPE || scope.startsWith(`${WORKSPACE_SCOPE}:`)) {
    return "workspace";
  }
  return "global";
}

function workspaceKeyFromScope(scope: LeaseScope): string | undefined {
  if (!scope.startsWith(`${WORKSPACE_SCOPE}:`)) {
    return undefined;
  }
  return scope.slice(WORKSPACE_SCOPE.length + 1);
}

function normalizeWorkspaceKey(workspaceKey: string): string {
  const normalized = path.resolve(workspaceKey.trim());
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
