import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry, type LeaseGuard, type EnsureLeaseForToolCallInput } from "../src/index.ts";

const activeLeaseGuard: LeaseGuard = {
  hasActiveLease(leaseId: string): boolean {
    return leaseId === "lease_active";
  }
};

test("executes passive tools without a lease", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "git.status",
    description: "status",
    handler: () => ({ ok: true })
  });

  const result = await registry.execute(
    {
      type: "tool_call",
      request_id: "req_1",
      tool: "git.status"
    },
    activeLeaseGuard
  );

  assert.equal(result.status, "ok");
});

test("derives advertised capabilities from registered tool definitions", () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.open_url",
    description: "open",
    handler: () => ({ ok: true })
  });

  const capabilities = registry.capabilities();
  assert.equal(capabilities.length, 1);
  assert.equal(capabilities[0].name, "browser.open_url");
  assert.equal(capabilities[0].access, "lease_required");
  assert.deepEqual(capabilities[0].inputSchema?.required, ["url"]);
  assert.equal((capabilities[0].inputSchema?.properties as { url?: { type?: string } } | undefined)?.url?.type, "string");
});

test("rejects missing required arguments before tool execution", async () => {
  let executed = false;
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.open_url",
    description: "open",
    handler: () => {
      executed = true;
      return { ok: true };
    }
  });

  const result = await registry.execute(
    {
      type: "tool_call",
      request_id: "req_1",
      tool: "browser.open_url",
      arguments: {}
    },
    activeLeaseGuard
  );

  assert.equal(result.status, "error");
  assert.equal(result.error_code, "invalid_arguments");
  assert.equal(result.message, "url is required");
  assert.equal(executed, false);
});

test("rejects stateful tools without a lease", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.open_url",
    description: "open",
    handler: () => ({ ok: true })
  });

  const result = await registry.execute(
    {
      type: "tool_call",
      request_id: "req_1",
      tool: "browser.open_url",
      arguments: { url: "https://example.com" }
    },
    activeLeaseGuard
  );

  assert.equal(result.status, "error");
  assert.equal(result.error_code, "lease_required");
});

test("executes stateful tools with the active lease", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.open_url",
    description: "open",
    handler: (args) => ({ url: args.url })
  });

  const result = await registry.execute(
    {
      type: "tool_call",
      request_id: "req_1",
      lease_id: "lease_active",
      tool: "browser.open_url",
      arguments: { url: "https://example.com" }
    },
    activeLeaseGuard
  );

  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.deepEqual(result.result, { url: "https://example.com" });
  }
});

test("executes tools with broker argument aliases", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.open_url",
    description: "open",
    handler: (args) => ({ url: args.url })
  });

  const result = await registry.execute(
    {
      type: "tool_call",
      request_id: "req_1",
      lease_id: "lease_active",
      tool: "browser.open_url",
      input: { url: "https://example.com/from-input" }
    },
    activeLeaseGuard
  );

  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.deepEqual(result.result, { url: "https://example.com/from-input" });
  }
});

test("executes tools with JSON string arguments", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "coding_agent.start_task",
    description: "start",
    handler: (args) => ({ prompt: args.prompt })
  });

  const result = await registry.execute(
    {
      type: "tool_call",
      request_id: "req_1",
      lease_id: "lease_active",
      tool: "coding_agent.start_task",
      arguments: "{\"prompt\":\"check the repo\"}"
    },
    activeLeaseGuard
  );

  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.deepEqual(result.result, { prompt: "check the repo" });
  }
});

test("uses lease guard auto-acquire for stateful tools without a lease id", async () => {
  const ensured: EnsureLeaseForToolCallInput[] = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.open_url",
    description: "open",
    handler: (_args, context) => ({
      lease_id: context.leaseId ?? null,
      agent_id: context.agentId ?? null,
      task_id: context.taskId ?? null,
      event_run_id: context.eventRunId ?? null,
      requested_action_key: context.requestedActionKey ?? null
    })
  });

  const result = await registry.execute(
    {
      type: "tool_call",
      request_id: "req_1",
      agent_id: 12,
      event_run_id: 192,
      requested_action_key: "local_runtime_45.browser",
      tool: "browser.open_url",
      arguments: { url: "https://example.com" }
    },
    {
      hasActiveLease: () => false,
      ensureLeaseForToolCall: (input) => {
        ensured.push(input);
        return { status: "ok", leaseId: "lease_auto" };
      }
    }
  );

  assert.equal(result.status, "ok");
  assert.deepEqual(ensured[0], {
    requestId: "req_1",
    leaseId: undefined,
    agentId: "12",
    taskId: "192",
    requestedActionKey: "local_runtime_45.browser",
    toolName: "browser.open_url"
  });
  if (result.status === "ok") {
    assert.deepEqual(result.result, {
      lease_id: "lease_auto",
      agent_id: "12",
      task_id: "192",
      event_run_id: "192",
      requested_action_key: "local_runtime_45.browser"
    });
  }
});

test("returns busy from lease guard when another lease is active", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.open_url",
    description: "open",
    handler: () => ({ ok: true })
  });

  const result = await registry.execute(
    {
      type: "tool_call",
      request_id: "req_1",
      agent_id: "agent_2",
      task_id: "task_2",
      tool: "browser.open_url",
      arguments: { url: "https://example.com" }
    },
    {
      hasActiveLease: () => false,
      ensureLeaseForToolCall: () => ({
        status: "error",
        errorCode: "busy",
        message: "Another agent owns the active lease."
      })
    }
  );

  assert.equal(result.status, "error");
  assert.equal(result.error_code, "busy");
});
