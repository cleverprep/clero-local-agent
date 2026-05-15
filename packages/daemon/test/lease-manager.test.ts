import assert from "node:assert/strict";
import test from "node:test";
import { LeaseManager } from "../src/lease-manager.ts";

test("grants a lease when no active lease exists", () => {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const manager = new LeaseManager({
    now: () => now,
    leaseIdFactory: () => "lease_1"
  });

  const result = manager.acquireLease({
    agentId: "agent_1",
    taskId: "task_1",
    requestedTools: ["browser.open_url"],
    ttlSeconds: 10
  });

  assert.equal(result.status, "granted");
  if (result.status === "granted") {
    assert.equal(result.lease.lease_id, "lease_1");
    assert.equal(result.lease.expires_at, "2026-01-01T00:00:10.000Z");
  }

  now += 1;
  assert.equal(manager.hasActiveLease("lease_1"), true);
});

test("returns busy when another agent owns the lease", () => {
  const manager = new LeaseManager({ leaseIdFactory: () => "lease_1" });
  manager.acquireLease({
    agentId: "agent_1",
    taskId: "task_1",
    requestedTools: ["browser.open_url"]
  });

  const result = manager.acquireLease({
    agentId: "agent_2",
    taskId: "task_2",
    requestedTools: ["browser.open_url"]
  });

  assert.equal(result.status, "busy");
});

test("expires the lease when heartbeat stops", () => {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const manager = new LeaseManager({
    now: () => now,
    leaseIdFactory: () => "lease_1"
  });
  manager.acquireLease({
    agentId: "agent_1",
    taskId: "task_1",
    requestedTools: ["browser.open_url"],
    ttlSeconds: 1
  });

  now += 1_001;

  assert.equal(manager.hasActiveLease("lease_1"), false);
  const result = manager.acquireLease({
    agentId: "agent_2",
    taskId: "task_2",
    requestedTools: ["browser.open_url"]
  });
  assert.equal(result.status, "granted");
});

test("heartbeat extends the lease", () => {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const manager = new LeaseManager({
    now: () => now,
    leaseIdFactory: () => "lease_1"
  });
  manager.acquireLease({
    agentId: "agent_1",
    taskId: "task_1",
    requestedTools: ["browser.open_url"],
    ttlSeconds: 1
  });

  now += 500;
  const heartbeat = manager.heartbeatLease("lease_1", 10);

  assert.equal(heartbeat.status, "ok");
  if (heartbeat.status === "ok") {
    assert.equal(heartbeat.lease.expires_at, "2026-01-01T00:00:10.500Z");
  }
});

test("default lease inactivity timeout is 60 seconds", () => {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const manager = new LeaseManager({
    now: () => now,
    leaseIdFactory: () => "lease_1"
  });

  const result = manager.acquireLease({
    agentId: "agent_1",
    taskId: "task_1",
    requestedTools: ["browser.open_url"]
  });

  assert.equal(result.status, "granted");
  if (result.status === "granted") {
    assert.equal(result.lease.expires_at, "2026-01-01T00:01:00.000Z");
  }

  now += 59_999;
  assert.equal(manager.hasActiveLease("lease_1"), true);

  now += 2;
  assert.equal(manager.hasActiveLease("lease_1"), false);
});

test("tool usage refreshes lease inactivity timeout", () => {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const manager = new LeaseManager({
    now: () => now,
    leaseIdFactory: () => "lease_1"
  });

  manager.acquireLease({
    agentId: "agent_1",
    taskId: "task_1",
    requestedTools: ["browser.open_url"]
  });

  now += 30_000;
  const ensured = manager.ensureLeaseForToolCall({
    requestId: "req_1",
    leaseId: "lease_1",
    agentId: "agent_1",
    taskId: "task_1",
    toolName: "browser.open_url"
  });

  assert.deepEqual(ensured, { status: "ok", leaseId: "lease_1" });
  const status = manager.getStatus();
  assert.equal(status.active_lease?.expires_at, "2026-01-01T00:01:30.000Z");
});

test("defaults to one connected agent slot", () => {
  const manager = new LeaseManager({ leaseIdFactory: () => "lease_1" });

  assert.equal(manager.registerAgent("agent_1"), true);
  assert.equal(manager.registerAgent("agent_2"), false);
  assert.equal(manager.getStatus().max_agent_slots, 1);
});

test("release frees the single connected agent slot", () => {
  const manager = new LeaseManager({ leaseIdFactory: () => "lease_1" });
  const lease = manager.acquireLease({
    agentId: "agent_1",
    taskId: "task_1",
    requestedTools: ["browser.open_url"]
  });
  assert.equal(lease.status, "granted");
  assert.equal(manager.registerAgent("agent_2"), false);
  if (lease.status === "granted") {
    manager.releaseLease(lease.lease.lease_id);
  }

  assert.equal(manager.registerAgent("agent_2"), true);
});

test("release clears the active lease", () => {
  const manager = new LeaseManager({ leaseIdFactory: () => "lease_1" });
  manager.acquireLease({
    agentId: "agent_1",
    taskId: "task_1",
    requestedTools: ["browser.open_url"]
  });

  assert.deepEqual(manager.releaseLease("lease_1"), { status: "released" });
  assert.equal(manager.hasActiveLease("lease_1"), false);
});

test("auto-acquires a lease for a stateful tool call when no lease exists", () => {
  const manager = new LeaseManager({ leaseIdFactory: () => "lease_auto" });

  const result = manager.ensureLeaseForToolCall({
    requestId: "req_1",
    agentId: "agent_1",
    taskId: "task_1",
    toolName: "browser.open_url"
  });

  assert.deepEqual(result, { status: "ok", leaseId: "lease_auto" });
  assert.equal(manager.hasActiveLease("lease_auto"), true);
});

test("auto-acquire returns busy when another agent owns the lease", () => {
  const manager = new LeaseManager({ leaseIdFactory: () => "lease_1" });
  manager.acquireLease({
    agentId: "agent_1",
    taskId: "task_1",
    requestedTools: ["browser.open_url"]
  });

  const result = manager.ensureLeaseForToolCall({
    requestId: "req_2",
    agentId: "agent_2",
    taskId: "task_2",
    toolName: "browser.open_url"
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.errorCode, "busy");
    assert.equal(result.message, "Local runtime is busy.");
    assert.deepEqual(result.details, {
      active_lease: {
        agent_id: "agent_1",
        task_id: "task_1",
        expires_at: manager.getStatus().active_lease?.expires_at
      }
    });
  }
});

test("same agent can reuse and extend the local lease across event runs without backend lease id", () => {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const manager = new LeaseManager({
    now: () => now,
    leaseIdFactory: () => "lease_1"
  });

  manager.ensureLeaseForToolCall({
    requestId: "req_1",
    agentId: "12",
    taskId: "192",
    requestedActionKey: "local_runtime_45.browser",
    toolName: "browser.open_url"
  });

  now += 30_000;
  const result = manager.ensureLeaseForToolCall({
    requestId: "req_2",
    agentId: "12",
    taskId: "193",
    requestedActionKey: "local_runtime_45.browser",
    toolName: "browser.click"
  });

  assert.deepEqual(result, { status: "ok", leaseId: "lease_1" });
  assert.equal(manager.getStatus().active_lease?.expires_at, "2026-01-01T00:01:30.000Z");
  assert.equal(manager.getStatus().active_lease?.task_id, "193");
});

test("different agent gets busy while local lease is active", () => {
  const manager = new LeaseManager({ leaseIdFactory: () => "lease_1" });

  manager.ensureLeaseForToolCall({
    requestId: "req_1",
    agentId: "12",
    taskId: "192",
    toolName: "browser.open_url"
  });

  const result = manager.ensureLeaseForToolCall({
    requestId: "req_2",
    agentId: "13",
    taskId: "193",
    toolName: "browser.open_url"
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.errorCode, "busy");
    assert.equal(result.message, "Local runtime is busy.");
  }
});
