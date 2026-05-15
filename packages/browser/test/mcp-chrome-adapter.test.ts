import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionError } from "@clero-local-agent/mcp-runtime";
import { McpChromeBrowserAdapter, type McpToolClient } from "../src/index.ts";
import type { JsonObject, JsonValue } from "@clero-local-agent/protocol";

class FakeMcpClient implements McpToolClient {
  readonly calls: Array<{ name: string; args: JsonObject }> = [];

  async callTool(name: string, args: JsonObject): Promise<JsonValue> {
    this.calls.push({ name, args });

    if (name === "get_windows_and_tabs") {
      return mcpTextResult({
        windows: [
          {
            windowId: 1,
            tabs: [
              { tabId: 10, active: false, url: "https://example.com/old" },
              { tabId: 11, active: true, url: "https://example.com/current" }
            ]
          }
        ]
      });
    }

    return mcpTextResult({ success: true, name, args });
  }

  async listTools(): Promise<JsonValue> {
    return mcpTextResult({ tools: [{ name: "chrome_navigate" }] });
  }
}

test("open_url maps to mcp-chrome navigation", async () => {
  const client = new FakeMcpClient();
  const adapter = new McpChromeBrowserAdapter({ client });

  const result = await adapter.openUrl({
    url: "https://example.com",
    new_window: true,
    width: 1440,
    height: 900
  });

  assert.equal(client.calls[0]?.name, "chrome_navigate");
  assert.deepEqual(client.calls[0]?.args, {
    url: "https://example.com",
    newWindow: true,
    width: 1440,
    height: 900
  });
  assert.equal(result.success, true);
});

test("open_url rejects local file URLs", async () => {
  const client = new FakeMcpClient();
  const adapter = new McpChromeBrowserAdapter({ client });

  await assert.rejects(
    () => adapter.openUrl({ url: "file:///Users/yakupovayaz/Projects/cleverprep_backend/cleverprep/" }),
    (error: unknown) => error instanceof ToolExecutionError && error.errorCode === "invalid_arguments"
  );
  assert.equal(client.calls.length, 0);
});

test("click maps coordinates to chrome_click_element", async () => {
  const client = new FakeMcpClient();
  const adapter = new McpChromeBrowserAdapter({ client });

  await adapter.click({ x: 120, y: 240 });

  assert.equal(client.calls[0]?.name, "chrome_click_element");
  assert.deepEqual(client.calls[0]?.args, {
    coordinates: { x: 120, y: 240 }
  });
});

test("mouse tools map to chrome_computer actions", async () => {
  const client = new FakeMcpClient();
  const adapter = new McpChromeBrowserAdapter({ client });

  await adapter.moveMouse({ x: 10, y: 20, steps: 3 });
  await adapter.mouseDown({ button: "left" });
  await adapter.moveMouse({ x: 30, y: 40 });
  await adapter.mouseUp({ button: "left" });
  await adapter.drag({ from_x: 1, from_y: 2, to_x: 3, to_y: 4, steps: 5 });

  assert.deepEqual(client.calls.map((call) => call.args), [
    { action: "move_mouse", x: 10, y: 20, steps: 3 },
    { action: "mouse_down", button: "left" },
    { action: "move_mouse", x: 30, y: 40, steps: 1 },
    { action: "mouse_up", button: "left" },
    { action: "drag", from_x: 1, from_y: 2, to_x: 3, to_y: 4, steps: 5, button: "left" }
  ]);
});

test("type fills targeted fields and types raw text otherwise", async () => {
  const client = new FakeMcpClient();
  const adapter = new McpChromeBrowserAdapter({ client });

  await adapter.type({ ref: "ref_7", text: "user@example.com" });
  await adapter.type({ text: "hello" });

  assert.equal(client.calls[0]?.name, "chrome_fill_or_select");
  assert.deepEqual(client.calls[0]?.args, {
    ref: "ref_7",
    value: "user@example.com"
  });
  assert.equal(client.calls[1]?.name, "chrome_computer");
  assert.deepEqual(client.calls[1]?.args, {
    action: "type",
    text: "hello"
  });
});

test("close_tab closes the active tab when no tab id is provided", async () => {
  const client = new FakeMcpClient();
  const adapter = new McpChromeBrowserAdapter({ client });

  await adapter.closeTab({});

  assert.equal(client.calls[0]?.name, "get_windows_and_tabs");
  assert.equal(client.calls[1]?.name, "chrome_close_tabs");
  assert.deepEqual(client.calls[1]?.args, {
    tabIds: [11]
  });
});

function mcpTextResult(value: JsonValue): JsonObject {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value)
      }
    ],
    isError: false
  };
}
