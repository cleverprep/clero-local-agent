import { randomUUID } from "node:crypto";
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
  ttlSeconds?: number;
};

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
  private activeLeaseValue: ActiveLease | null = null;

  constructor(options: LeaseManagerOptions = {}) {
    this.maxAgentSlots = options.maxAgentSlots ?? 1;
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
    if (this.activeLeaseValue) {
      if (this.activeLeaseValue.agent_id === input.agentId) {
        this.activeLeaseValue = {
          ...this.activeLeaseValue,
          task_id: input.taskId,
          requested_tools: input.requestedTools,
          expires_at: this.expiresAt(ttlSeconds)
        };
        return { status: "granted", lease: this.activeLeaseValue };
      }

      return { status: "busy", activeLease: this.activeLeaseValue };
    }

    if (this.maxAgentSlots === 1) {
      this.sessions.clear();
    }
    const registration = this.sessions.register(input.agentId);
    if (registration.status === "slot_limit") {
      return { status: "slot_limit", maxAgentSlots: registration.maxAgentSlots };
    }

    this.activeLeaseValue = {
      lease_id: this.leaseIdFactory(),
      agent_id: input.agentId,
      task_id: input.taskId,
      requested_tools: input.requestedTools,
      expires_at: this.expiresAt(ttlSeconds)
    };

    return { status: "granted", lease: this.activeLeaseValue };
  }

  heartbeatLease(leaseId: string, ttlSeconds = this.defaultTtlSeconds): HeartbeatLeaseResult {
    this.expireLeaseIfNeeded();
    if (!this.activeLeaseValue || this.activeLeaseValue.lease_id !== leaseId) {
      return { status: "not_found" };
    }

    if (this.isExpired(this.activeLeaseValue)) {
      this.activeLeaseValue = null;
      return { status: "expired" };
    }

    this.activeLeaseValue = {
      ...this.activeLeaseValue,
      expires_at: this.expiresAt(ttlSeconds)
    };
    this.sessions.touch(this.activeLeaseValue.agent_id);
    return { status: "ok", lease: this.activeLeaseValue };
  }

  releaseLease(leaseId: string): ReleaseLeaseResult {
    this.expireLeaseIfNeeded();
    if (!this.activeLeaseValue || this.activeLeaseValue.lease_id !== leaseId) {
      return { status: "not_found" };
    }

    this.sessions.unregister(this.activeLeaseValue.agent_id);
    this.activeLeaseValue = null;
    return { status: "released" };
  }

  hasActiveLease(leaseId: string): boolean {
    this.expireLeaseIfNeeded();
    return Boolean(this.activeLeaseValue && this.activeLeaseValue.lease_id === leaseId);
  }

  ensureLeaseForToolCall(input: EnsureLeaseForToolCallInput): EnsureLeaseForToolCallResult {
    this.expireLeaseIfNeeded();

    if (input.leaseId && this.activeLeaseValue?.lease_id === input.leaseId) {
      const heartbeat = this.heartbeatLease(input.leaseId);
      if (heartbeat.status === "ok") {
        return { status: "ok", leaseId: heartbeat.lease.lease_id };
      }
    }

    if (this.activeLeaseValue) {
      const requestedAgentId = input.agentId;
      const sameOwner = requestedAgentId === this.activeLeaseValue.agent_id;

      if (sameOwner && !input.leaseId) {
        const refreshed = this.acquireLease({
          agentId: input.agentId ?? this.activeLeaseValue.agent_id,
          taskId: input.taskId ?? this.activeLeaseValue.task_id,
          requestedTools: [input.requestedActionKey ?? input.toolName]
        });
        if (refreshed.status === "granted") {
          return { status: "ok", leaseId: refreshed.lease.lease_id };
        }
      }

      return {
        status: "error",
        errorCode: "busy",
        message: "Local runtime is busy.",
        details: this.busyDetails(this.activeLeaseValue)
      };
    }

    const agentId = input.agentId ?? "implicit_agent";
    const taskId = input.taskId ?? input.requestId;
    const acquired = this.acquireLease({
      agentId,
      taskId,
      requestedTools: [input.requestedActionKey ?? input.toolName]
    });

    if (acquired.status === "granted") {
      return { status: "ok", leaseId: acquired.lease.lease_id };
    }

    if (acquired.status === "busy") {
      return {
        status: "error",
        errorCode: "busy",
        message: "Local runtime is busy.",
        details: this.busyDetails(acquired.activeLease)
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
    return {
      status: "online",
      max_agent_slots: this.maxAgentSlots,
      connected_agents: this.sessions.size(),
      active_lease: this.activeLeaseValue
    };
  }

  registerAgent(agentId: string): boolean {
    return this.sessions.register(agentId).status !== "slot_limit";
  }

  unregisterAgent(agentId: string): void {
    if (this.activeLeaseValue?.agent_id === agentId) {
      this.activeLeaseValue = null;
    }

    this.sessions.unregister(agentId);
  }

  clearActiveLease(): void {
    this.sessions.clear();
    this.activeLeaseValue = null;
  }

  private expireLeaseIfNeeded(): void {
    if (this.activeLeaseValue && this.isExpired(this.activeLeaseValue)) {
      this.sessions.unregister(this.activeLeaseValue.agent_id);
      this.activeLeaseValue = null;
    }
  }

  private isExpired(lease: ActiveLease): boolean {
    return Date.parse(lease.expires_at) <= this.now();
  }

  private expiresAt(ttlSeconds: number): string {
    return new Date(this.now() + ttlSeconds * 1000).toISOString();
  }

  private busyDetails(lease: ActiveLease): JsonObject {
    return {
      active_lease: {
        agent_id: lease.agent_id,
        task_id: lease.task_id,
        expires_at: lease.expires_at
      }
    };
  }
}
