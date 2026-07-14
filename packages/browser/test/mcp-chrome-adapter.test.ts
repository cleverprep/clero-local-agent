import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolExecutionError } from "@clero-local-agent/mcp-runtime";
import {
  AgentScopedManagedBrowserAdapter,
  BrowserTools,
  BrowserDebugTools,
  ChromeDevToolsBrowserDebugAdapter,
  McpChromeBrowserAdapter,
  type BrowserAdapter,
  type McpToolClient
} from "../src/index.ts";
import type { JsonObject, JsonValue } from "@clero-local-agent/protocol";
import { WorkspacePolicy } from "../../workspace/src/index.ts";

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

test("type clicks targeted fields before typing and fill replaces targeted fields", async () => {
  const client = new FakeMcpClient();
  const adapter = new McpChromeBrowserAdapter({ client });

  await adapter.type({ ref: "ref_7", text: "user@example.com" });
  await adapter.type({ text: "hello" });
  await adapter.fill({ selector: "#email", text: "admin@example.com" });

  assert.equal(client.calls[0]?.name, "chrome_click_element");
  assert.deepEqual(client.calls[0]?.args, {
    ref: "ref_7"
  });
  assert.equal(client.calls[1]?.name, "chrome_computer");
  assert.deepEqual(client.calls[1]?.args, {
    action: "type",
    text: "user@example.com"
  });
  assert.equal(client.calls[2]?.name, "chrome_computer");
  assert.deepEqual(client.calls[2]?.args, {
    action: "type",
    text: "hello"
  });
  assert.equal(client.calls[3]?.name, "chrome_fill_or_select");
  assert.deepEqual(client.calls[3]?.args, {
    selector: "#email",
    value: "admin@example.com"
  });
});

test("fill requires a target field", async () => {
  const client = new FakeMcpClient();
  const adapter = new McpChromeBrowserAdapter({ client });

  await assert.rejects(
    () => adapter.fill({ text: "admin@example.com" }),
    (error: unknown) => error instanceof ToolExecutionError && error.errorCode === "invalid_arguments"
  );
  assert.equal(client.calls.length, 0);
});

test("browser upload resolves allowed files before forwarding to the managed adapter", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clero-browser-upload-"));
  const filePath = path.join(root, "report.txt");
  await writeFile(filePath, "approved upload");
  let forwarded: JsonObject | undefined;
  const adapter: BrowserAdapter = {
    ...fakeBrowserAdapter({}),
    async uploadFile(args) {
      forwarded = args;
      return { uploaded: true };
    }
  };
  const workspacePolicy = new WorkspacePolicy({ allowedDirectories: [root] });
  const browserTools = new BrowserTools(adapter, {
    resolveFilePath: (candidate) => workspacePolicy.resolveAllowedFile(candidate)
  });
  const upload = browserTools
    .definitions()
    .find((definition) => definition.name === "browser.upload_file");

  try {
    assert.ok(upload);
    const result = await upload.handler(
      {
        selector: "#attachment",
        file_path: filePath,
        expected_url: "https://example.com/upload"
      },
      { requestId: "req_upload" }
    );

    assert.deepEqual(result, { uploaded: true });
    assert.deepEqual(forwarded, {
      selector: "#attachment",
      file_paths: [await realpath(filePath)],
      expected_url: "https://example.com/upload"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed browser advertises upload without a local approval provider", () => {
  const adapter: BrowserAdapter = {
    ...fakeBrowserAdapter({}),
    async uploadFile() {
      return { uploaded: true };
    }
  };
  const browserTools = new BrowserTools(adapter, {
    resolveFilePath: (filePath) => filePath
  });

  assert.equal(
    browserTools.definitions().some((definition) => definition.name === "browser.upload_file"),
    true
  );
});

test("mcp-chrome does not advertise local file upload support", () => {
  const adapter = new McpChromeBrowserAdapter({ client: new FakeMcpClient() });
  const browserTools = new BrowserTools(adapter, {
    resolveFilePath: (filePath) => filePath
  });

  assert.equal(
    browserTools.definitions().some((definition) => definition.name === "browser.upload_file"),
    false
  );
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

test("agent-scoped managed browser keeps separate persistent profile directories", async () => {
  const createdProfileDirs: string[] = [];
  const createdViewports: Array<{ width: number; height: number } | undefined> = [];
  const adapter = new AgentScopedManagedBrowserAdapter({
    userDataDir: "/tmp/clero-browser-root",
    viewport: { width: 1440, height: 900 },
    sessionFactory: (options) => {
      createdProfileDirs.push(options.userDataDir ?? "");
      createdViewports.push(options.viewport);
      return fakeBrowserAdapter({ profile_dir: options.userDataDir ?? "" });
    }
  });

  const first = await adapter.listTabs({}, { requestId: "req_1", agentId: "15", taskId: "task_1" });
  const second = await adapter.listTabs({}, { requestId: "req_2", agentId: "22", taskId: "task_2" });
  const again = await adapter.listTabs({}, { requestId: "req_3", agentId: "15", taskId: "task_3" });

  assert.deepEqual(createdProfileDirs, [
    path.join("/tmp/clero-browser-root", "agent-15"),
    path.join("/tmp/clero-browser-root", "agent-22")
  ]);
  assert.deepEqual(createdViewports, [
    { width: 1440, height: 900 },
    { width: 1440, height: 900 }
  ]);
  assert.equal(first.browser_session_id, "agent-15");
  assert.equal(first.agent_id, "15");
  assert.equal(second.browser_session_id, "agent-22");
  assert.equal(again.profile_dir, path.join("/tmp/clero-browser-root", "agent-15"));
});

test("agent-scoped managed browser restarts a stale closed session once", async () => {
  const createdProfileDirs: string[] = [];
  const disposed: string[] = [];
  let firstCall = true;
  const adapter = new AgentScopedManagedBrowserAdapter({
    userDataDir: "/tmp/clero-browser-root",
    sessionFactory: (options) => {
      const profileDir = options.userDataDir ?? "";
      createdProfileDirs.push(profileDir);
      return {
        ...fakeBrowserAdapter({ profile_dir: profileDir }),
        async listTabs() {
          if (firstCall) {
            firstCall = false;
            throw new Error("browser is closed");
          }
          return { profile_dir: profileDir };
        },
        async dispose() {
          disposed.push(profileDir);
        }
      };
    }
  });

  const result = await adapter.listTabs({}, { requestId: "req_1", agentId: "15", taskId: "task_1" });

  assert.deepEqual(createdProfileDirs, [
    path.join("/tmp/clero-browser-root", "agent-15"),
    path.join("/tmp/clero-browser-root", "agent-15")
  ]);
  assert.deepEqual(disposed, [path.join("/tmp/clero-browser-root", "agent-15")]);
  assert.equal(result.profile_dir, path.join("/tmp/clero-browser-root", "agent-15"));
  assert.equal(result.browser_session_id, "agent-15");
});

test("browser debug tools list and proxy Chrome DevTools MCP tools", async () => {
  const client = new FakeMcpClient();
  const adapter = new ChromeDevToolsBrowserDebugAdapter({ client });
  const tools = new BrowserDebugTools(adapter);
  const definitions = tools.definitions();

  const listTools = definitions.find((definition) => definition.name === "browser_debug.list_tools");
  const callTool = definitions.find((definition) => definition.name === "browser_debug.call_tool");

  assert.ok(listTools);
  assert.ok(callTool);
  assert.deepEqual(await listTools.handler({}, { requestId: "req_1" }), { tools: [{ name: "chrome_navigate" }] });
  assert.deepEqual(await callTool.handler({ name: "performance_start_trace", arguments: { reload: true } }, { requestId: "req_2" }), {
    success: true,
    name: "performance_start_trace",
    args: { reload: true }
  });
  assert.deepEqual(client.calls.at(-1), {
    name: "performance_start_trace",
    args: { reload: true }
  });
});

test("browser debug call_tool requires a tool name", async () => {
  const client = new FakeMcpClient();
  const adapter = new ChromeDevToolsBrowserDebugAdapter({ client });

  await assert.rejects(() => adapter.callTool({ arguments: {} }), /name is required/);
  assert.equal(client.calls.length, 0);
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

function fakeBrowserAdapter(result: JsonObject): BrowserAdapter {
  const call = async () => result;
  return {
    listTabs: call,
    openUrl: call,
    switchTab: call,
    getPageContent: call,
    getInteractiveElements: call,
    getSnapshot: call,
    click: call,
    moveMouse: call,
    mouseDown: call,
    mouseUp: call,
    drag: call,
    type: call,
    fill: call,
    pressKey: call,
    screenshot: call,
    getConsoleLogs: call,
    getNetworkEvents: call,
    closeTab: call,
    goBack: call,
    goForward: call
  };
}
