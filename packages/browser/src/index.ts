import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ApprovalProvider } from "@clero-local-agent/approvals";
import { ToolExecutionError, type ToolDefinition, type ToolExecutionContext } from "@clero-local-agent/mcp-runtime";
import { isJsonObject, type JsonObject, type JsonValue } from "@clero-local-agent/protocol";

type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id?: number | string | null;
  result?: JsonValue;
  error?: {
    code?: number;
    message?: string;
    data?: JsonValue;
  };
};

export interface BrowserAdapter {
  dispose?(): Promise<void>;
  listTabs(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  openUrl(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  switchTab(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  getPageContent(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  getInteractiveElements(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  getSnapshot(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  click(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  moveMouse(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  mouseDown(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  mouseUp(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  drag(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  type(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  fill(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  uploadFile?(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  pressKey(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  screenshot(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  getConsoleLogs(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  getNetworkEvents(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  closeTab(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  goBack(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  goForward(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
}

export interface McpToolClient {
  callTool(name: string, args: JsonObject): Promise<JsonValue>;
  listTools(): Promise<JsonValue>;
}

export interface BrowserDebugAdapter {
  dispose?(): Promise<void>;
  listTools(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
  callTool(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject>;
}

export type BrowserToolsOptions = {
  approvalProvider?: ApprovalProvider;
  resolveFilePath?: (filePath: string) => string;
};

export class BrowserTools {
  private readonly adapter: BrowserAdapter;
  private readonly approvalProvider?: ApprovalProvider;
  private readonly resolveFilePath?: (filePath: string) => string;

  constructor(adapter: BrowserAdapter, options: BrowserToolsOptions = {}) {
    this.adapter = adapter;
    this.approvalProvider = options.approvalProvider;
    this.resolveFilePath = options.resolveFilePath;
  }

  definitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [
      {
        name: "browser.list_tabs",
        description: "List pages in the local managed browser session.",
        handler: (args, context) => this.adapter.listTabs(args, context)
      },
      {
        name: "browser.open_url",
        description: "Open a URL in the local managed browser session.",
        handler: (args, context) => this.adapter.openUrl(args, context)
      },
      {
        name: "browser.switch_tab",
        description: "Switch to an existing browser tab.",
        handler: (args, context) => this.adapter.switchTab(args, context)
      },
      {
        name: "browser.get_page_content",
        description: "Extract visible page text or HTML from the active tab.",
        handler: (args, context) => this.adapter.getPageContent(args, context)
      },
      {
        name: "browser.get_interactive_elements",
        description: "Read interactive elements from the active page.",
        handler: (args, context) => this.adapter.getInteractiveElements(args, context)
      },
      {
        name: "browser.get_snapshot",
        description: "Read an accessibility-like page snapshot.",
        handler: (args, context) => this.adapter.getSnapshot(args, context)
      },
      {
        name: "browser.click",
        description: "Click a page element by ref, selector, or coordinates.",
        handler: (args, context) => this.adapter.click(args, context)
      },
      {
        name: "browser.move_mouse",
        description: "Move the mouse pointer to page coordinates.",
        handler: (args, context) => this.adapter.moveMouse(args, context)
      },
      {
        name: "browser.mouse_down",
        description: "Press and hold a mouse button.",
        handler: (args, context) => this.adapter.mouseDown(args, context)
      },
      {
        name: "browser.mouse_up",
        description: "Release a mouse button.",
        handler: (args, context) => this.adapter.mouseUp(args, context)
      },
      {
        name: "browser.drag",
        description: "Drag from one page coordinate to another.",
        handler: (args, context) => this.adapter.drag(args, context)
      },
      {
        name: "browser.type",
        description: "Type text like keyboard input. When a ref or selector is provided, click that field first and append text without clearing it.",
        handler: (args, context) => this.adapter.type(args, context)
      },
      {
        name: "browser.fill",
        description: "Replace the value of a targeted input field by ref or selector.",
        handler: (args, context) => this.adapter.fill(args, context)
      },
      {
        name: "browser.press_key",
        description: "Press a keyboard key or shortcut in the browser.",
        handler: (args, context) => this.adapter.pressKey(args, context)
      },
      {
        name: "browser.screenshot",
        description: "Capture a screenshot from the active tab.",
        handler: (args, context) => this.adapter.screenshot(args, context)
      },
      {
        name: "browser.get_console_logs",
        description: "Return captured console output from the active tab.",
        handler: (args, context) => this.adapter.getConsoleLogs(args, context)
      },
      {
        name: "browser.get_network_events",
        description: "Return captured browser network events.",
        handler: (args, context) => this.adapter.getNetworkEvents(args, context)
      },
      {
        name: "browser.go_back",
        description: "Navigate the active tab back.",
        handler: (args, context) => this.adapter.goBack(args, context)
      },
      {
        name: "browser.go_forward",
        description: "Navigate the active tab forward.",
        handler: (args, context) => this.adapter.goForward(args, context)
      },
      {
        name: "browser.close_tab",
        description: "Close the active or selected browser tab.",
        handler: (args, context) => this.adapter.closeTab(args, context)
      },
      {
        name: "browser.close_page",
        description: "Compatibility alias for browser.close_tab.",
        handler: (args, context) => this.adapter.closeTab(args, context)
      }
    ];
    if (typeof this.adapter.uploadFile === "function" && this.approvalProvider && this.resolveFilePath) {
      const fillIndex = definitions.findIndex((definition) => definition.name === "browser.fill");
      definitions.splice(fillIndex + 1, 0, {
        name: "browser.upload_file",
        description:
          "Set one or more approved local files on a browser file input by ref or selector. Files must be inside allowed local directories.",
        handler: (args, context) => this.uploadFile(args, context)
      });
    }
    return definitions;
  }

  private async uploadFile(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    const uploadFile = this.adapter.uploadFile;
    const approvalProvider = this.approvalProvider;
    const resolveFilePath = this.resolveFilePath;
    if (!uploadFile || !approvalProvider || !resolveFilePath) {
      throw new ToolExecutionError("tool_failed", "Browser file uploads are unavailable for this browser provider.");
    }

    const filePaths = browserUploadFilePaths(args).map((filePath) => resolveFilePath(filePath));
    const resolvedArgs: JsonObject = {
      ...args,
      file_paths: filePaths
    };
    delete resolvedArgs.file_path;

    const expectedUrl = nonEmptyString(optionalString(args, "expected_url"));
    const target = nonEmptyString(optionalString(args, "ref")) ?? nonEmptyString(optionalString(args, "selector"));
    const approval = await approvalProvider.requestApproval({
      tool: "browser.upload_file",
      summary: `Upload ${filePaths.length} local file${filePaths.length === 1 ? "" : "s"} to ${expectedUrl ?? "the active browser page"}`,
      metadata: compactJsonObject({
        file_paths: filePaths,
        file_count: filePaths.length,
        expected_url: expectedUrl,
        target
      })
    });
    if (!approval.approved) {
      throw new ToolExecutionError("approval_denied", `Approval denied: ${approval.reason ?? "No reason provided"}`);
    }

    return uploadFile.call(this.adapter, resolvedArgs, context);
  }
}

export class BrowserDebugTools {
  private readonly adapter: BrowserDebugAdapter;

  constructor(adapter: BrowserDebugAdapter) {
    this.adapter = adapter;
  }

  definitions(): ToolDefinition[] {
    return [
      {
        name: "browser_debug.list_tools",
        description: "List Chrome DevTools MCP debugging tools available for the local browser.",
        handler: (args, context) => this.adapter.listTools(args, context)
      },
      {
        name: "browser_debug.call_tool",
        description: "Call a Chrome DevTools MCP debugging tool by name. Use browser_debug.list_tools first.",
        handler: (args, context) => this.adapter.callTool(args, context)
      }
    ];
  }
}

export type ManagedBrowserAdapterOptions = {
  userDataDir?: string;
  rememberSession?: boolean;
  headless?: boolean;
  browserChannel?: "chromium" | "chrome" | "chrome-beta" | "msedge";
  viewport?: BrowserViewport;
};

export type BrowserViewport = {
  width: number;
  height: number;
};

type ManagedPage = any;
type ManagedContext = any;
type PlaywrightModule = any;

type BrowserLogEvent = {
  at: string;
  level: string;
  text: string;
};

type BrowserNetworkEvent = {
  at: string;
  type: "request" | "response" | "requestfailed";
  url: string;
  method?: string;
  status?: number;
  failure?: string;
};

type BrowserRefTarget = {
  pageId: string;
  selector: string;
  frame?: any;
  frameUrl?: string;
  frameName?: string;
  x?: number;
  y?: number;
};

type FrameSnapshot = {
  frame: any;
  frameUrl: string;
  frameName: string;
  url: string;
  title: string;
  text: string;
  elements: Array<JsonObject & { selector: string; x?: number; y?: number; width?: number; height?: number }>;
  error?: string;
};

export class ManagedBrowserAdapter implements BrowserAdapter {
  private readonly userDataDir: string;
  private readonly removeUserDataDirOnDispose: boolean;
  private readonly headless: boolean;
  private readonly browserChannel?: string;
  private readonly viewport?: BrowserViewport;
  private playwright: PlaywrightModule | null = null;
  private context: ManagedContext | null = null;
  private contextPromise: Promise<ManagedContext> | null = null;
  private activePage: ManagedPage | null = null;
  private nextPageId = 1;
  private nextRefId = 1;
  private readonly pagesById = new Map<string, ManagedPage>();
  private readonly pageIds = new WeakMap<object, string>();
  private cdpBrowser: any | null = null;
  private readonly refs = new Map<string, BrowserRefTarget>();
  private readonly consoleLogs = new Map<string, BrowserLogEvent[]>();
  private readonly networkEvents = new Map<string, BrowserNetworkEvent[]>();

  constructor(options: ManagedBrowserAdapterOptions = {}) {
    const rememberSession = options.rememberSession !== false;
    this.userDataDir = rememberSession
      ? nonEmptyString(options.userDataDir) ?? path.join(os.homedir(), ".clero-local-agent", "browser-profile")
      : path.join(os.tmpdir(), "clero-local-agent", `browser-profile-${process.pid}-${randomUUID()}`);
    this.removeUserDataDirOnDispose = !rememberSession;
    this.headless = options.headless ?? false;
    this.browserChannel = options.browserChannel === "chromium" ? undefined : options.browserChannel;
    this.viewport = normalizeBrowserViewport(options.viewport);
  }

  async listTabs(_args: JsonObject = {}): Promise<JsonObject> {
    const context = await this.ensureContext();
    return {
      profile_dir: this.userDataDir,
      pages: await Promise.all(context.pages().map((page: ManagedPage) => this.describePage(page)))
    };
  }

  async dispose(): Promise<void> {
    const context = this.context ?? (await this.contextPromise?.catch(() => null));
    await context?.close().catch(() => null);
    if (typeof this.cdpBrowser?.close === "function") {
      await this.cdpBrowser.close().catch(() => null);
    }
    this.clearRuntimeState();
    if (this.removeUserDataDirOnDispose) {
      await rm(this.userDataDir, { recursive: true, force: true }).catch(() => null);
    }
  }

  async openUrl(args: JsonObject): Promise<JsonObject> {
    const url = webUrlArg(args, "url");
    const waitUntil = openUrlWaitUntil(args);
    const timeoutMs = boundedOptionalNumber(args, "timeout_ms", 1_000, 120_000) ?? 30_000;
    const settleMs = boundedOptionalNumber(args, "settle_ms", 0, 30_000) ?? 5_000;
    const page = optionalBoolean(args, "new_tab") || optionalBoolean(args, "new_window")
      ? await this.newPage()
      : await this.pageForNavigation(pageIdArg(args));
    await page.goto(url, { waitUntil, timeout: timeoutMs });
    await page.locator("body").waitFor({ state: "attached", timeout: Math.min(timeoutMs, 5_000) }).catch(() => null);
    if (settleMs > 0 && waitUntil !== "networkidle") {
      await page.waitForLoadState("networkidle", { timeout: settleMs }).catch(() => null);
    }
    await page.bringToFront();
    this.activePage = page;
    return this.describePage(page);
  }

  async switchTab(args: JsonObject): Promise<JsonObject> {
    const page = await this.requirePage(pageIdArg(args));
    await page.bringToFront();
    this.activePage = page;
    return this.describePage(page);
  }

  async getPageContent(args: JsonObject): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    const selector = optionalString(args, "selector");
    const format = optionalString(args, "format") ?? "text";
    if (selector) {
      const locator = page.locator(selector).first();
      return {
        page_id: this.pageId(page),
        selector,
        format,
        content: format === "html" ? await locator.evaluate((element: Element) => element.outerHTML) : await locator.innerText()
      };
    }

    if (format !== "html") {
      const frames = await this.collectFrameSnapshots(page);
      return {
        page_id: this.pageId(page),
        url: page.url(),
        title: await page.title(),
        format,
        content: this.snapshotText(frames),
        frames: frames.map((frame) => compactJsonObject({
          url: frame.url,
          title: frame.title,
          name: frame.frameName,
          text_length: frame.text.length,
          error: frame.error
        }))
      };
    }

    return {
      page_id: this.pageId(page),
      url: page.url(),
      title: await page.title(),
      format,
      content: format === "html" ? await page.content() : await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")
    };
  }

  async getInteractiveElements(args: JsonObject): Promise<JsonObject> {
    return this.snapshot(args, "interactive");
  }

  async getSnapshot(args: JsonObject): Promise<JsonObject> {
    return this.snapshot(args, optionalString(args, "filter") ?? "all");
  }

  async click(args: JsonObject): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    const target = this.resolveTarget(args, page);
    if (target.selector) {
      const frameOrPage = target.frame ?? page;
      await frameOrPage.locator(target.selector).first().click({ timeout: 10_000 }).catch(async (error: unknown) => {
        if (target.x === undefined || target.y === undefined) {
          throw error;
        }
        await page.mouse.click(target.x, target.y);
      });
      return compactJsonObject({
        clicked: true,
        page_id: this.pageId(page),
        selector: target.selector,
        frame_url: target.frameUrl,
        frame_name: target.frameName
      });
    }

    const x = requiredNumber(args, "x");
    const y = requiredNumber(args, "y");
    await page.mouse.click(x, y);
    return { clicked: true, page_id: this.pageId(page), x, y };
  }

  async moveMouse(args: JsonObject): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    const x = requiredNumber(args, "x");
    const y = requiredNumber(args, "y");
    const steps = boundedOptionalNumber(args, "steps", 1, 100) ?? 1;
    await page.mouse.move(x, y, { steps });
    return { moved: true, page_id: this.pageId(page), x, y, steps };
  }

  async mouseDown(args: JsonObject): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    const button = mouseButtonArg(args);
    await page.mouse.down({ button });
    return { mouse_down: true, page_id: this.pageId(page), button };
  }

  async mouseUp(args: JsonObject): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    const button = mouseButtonArg(args);
    await page.mouse.up({ button });
    return { mouse_up: true, page_id: this.pageId(page), button };
  }

  async drag(args: JsonObject): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    const fromX = requiredNumber(args, "from_x");
    const fromY = requiredNumber(args, "from_y");
    const toX = requiredNumber(args, "to_x");
    const toY = requiredNumber(args, "to_y");
    const steps = boundedOptionalNumber(args, "steps", 1, 100) ?? 10;
    const button = mouseButtonArg(args);
    await page.mouse.move(fromX, fromY);
    await page.mouse.down({ button });
    await page.mouse.move(toX, toY, { steps });
    await page.mouse.up({ button });
    return {
      dragged: true,
      page_id: this.pageId(page),
      from_x: fromX,
      from_y: fromY,
      to_x: toX,
      to_y: toY,
      steps,
      button
    };
  }

  async type(args: JsonObject): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    const text = requiredText(args);
    const target = this.resolveTarget(args, page);
    if (target.selector) {
      const frameOrPage = target.frame ?? page;
      const locator = frameOrPage.locator(target.selector).first();
      await locator.click({ timeout: 10_000 }).catch(async (error: unknown) => {
        if (target.x === undefined || target.y === undefined) {
          throw error;
        }
        await page.mouse.click(target.x, target.y);
      });
      await page.keyboard.type(text);
      return compactJsonObject({
        typed: true,
        page_id: this.pageId(page),
        selector: target.selector,
        length: text.length,
        frame_url: target.frameUrl,
        frame_name: target.frameName
      });
    }

    await page.keyboard.type(text);
    return { typed: true, page_id: this.pageId(page), length: text.length };
  }

  async fill(args: JsonObject): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    const text = requiredText(args);
    const target = this.resolveTarget(args, page);
    if (!target.selector) {
      throw new ToolExecutionError("invalid_arguments", "ref or selector is required");
    }

    const frameOrPage = target.frame ?? page;
    await frameOrPage.locator(target.selector).first().fill(text, { timeout: 10_000 });
    return compactJsonObject({
      filled: true,
      page_id: this.pageId(page),
      selector: target.selector,
      length: text.length,
      frame_url: target.frameUrl,
      frame_name: target.frameName
    });
  }

  async uploadFile(args: JsonObject): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    const actualUrl = page.url();
    const expectedUrl = nonEmptyString(optionalString(args, "expected_url"));
    if (expectedUrl && actualUrl !== expectedUrl) {
      throw new ToolExecutionError(
        "invalid_arguments",
        "The active browser page changed after the upload was prepared.",
        { expected_url: expectedUrl, actual_url: actualUrl }
      );
    }

    const target = this.resolveTarget(args, page);
    if (!target.selector) {
      throw new ToolExecutionError("invalid_arguments", "ref or selector is required");
    }
    const frameOrPage = target.frame ?? page;
    const locator = frameOrPage.locator(target.selector);
    const matchCount = await locator.count();
    if (matchCount !== 1) {
      throw new ToolExecutionError(
        "invalid_arguments",
        matchCount === 0
          ? "The browser file input was not found."
          : "The browser file selector matched more than one element.",
        { selector: target.selector, match_count: matchCount }
      );
    }

    const input = await locator.evaluate((element: Element) => ({
      tag: element.tagName.toLowerCase(),
      type: (element.getAttribute("type") ?? "").toLowerCase(),
      multiple: element.hasAttribute("multiple")
    }));
    if (input.tag !== "input" || input.type !== "file") {
      throw new ToolExecutionError(
        "invalid_arguments",
        "The target must be an input element with type=file.",
        { selector: target.selector, tag: input.tag, type: input.type }
      );
    }

    const filePaths = browserUploadFilePaths(args);
    if (filePaths.length > 1 && !input.multiple) {
      throw new ToolExecutionError(
        "invalid_arguments",
        "The selected browser file input accepts only one file.",
        { selector: target.selector, file_count: filePaths.length }
      );
    }

    const timeoutMs = boundedOptionalNumber(args, "timeout_ms", 1_000, 120_000) ?? 30_000;
    await locator.setInputFiles(filePaths, { timeout: timeoutMs });
    const files = await locator.evaluate((element: HTMLInputElement) =>
      Array.from(element.files ?? []).map((file) => ({
        name: file.name,
        size: file.size,
        type: file.type
      }))
    );
    if (files.length !== filePaths.length) {
      throw new ToolExecutionError(
        "tool_failed",
        "The browser did not retain every selected upload file.",
        { expected_file_count: filePaths.length, actual_file_count: files.length }
      );
    }

    return compactJsonObject({
      uploaded: true,
      page_id: this.pageId(page),
      url: actualUrl,
      selector: target.selector,
      frame_url: target.frameUrl,
      frame_name: target.frameName,
      file_count: files.length,
      files
    });
  }

  async pressKey(args: JsonObject): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    const key = requiredString(args, "key");
    await page.keyboard.press(key);
    return { pressed: key, page_id: this.pageId(page) };
  }

  async screenshot(args: JsonObject): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    const screenshot = await page.screenshot({
      fullPage: optionalBoolean(args, "full_page") ?? optionalBoolean(args, "fullPage") ?? false,
      type: "png"
    });
    return {
      page_id: this.pageId(page),
      mime_type: "image/png",
      data_base64: screenshot.toString("base64")
    };
  }

  async getConsoleLogs(args: JsonObject): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    return {
      page_id: this.pageId(page),
      logs: this.consoleLogs.get(this.pageId(page)) ?? []
    };
  }

  async getNetworkEvents(args: JsonObject): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    return {
      page_id: this.pageId(page),
      events: this.networkEvents.get(this.pageId(page)) ?? []
    };
  }

  async closeTab(args: JsonObject): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    const pageId = this.pageId(page);
    await page.close();
    this.pagesById.delete(pageId);
    this.consoleLogs.delete(pageId);
    this.networkEvents.delete(pageId);
    if (this.activePage === page) {
      const context = await this.ensureContext();
      this.activePage = context.pages()[0] ?? null;
    }
    return { closed: true, page_id: pageId };
  }

  async goBack(args: JsonObject): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
    return this.describePage(page);
  }

  async goForward(args: JsonObject): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => null);
    return this.describePage(page);
  }

  private async snapshot(args: JsonObject, filter: string): Promise<JsonObject> {
    const page = await this.ensurePage(pageIdArg(args));
    const pageId = this.pageId(page);
    const snapshots = await this.collectFrameSnapshots(page);
    const elements = snapshots.flatMap((snapshot) => snapshot.elements.map((element) => {
      const ref = `ref_${this.nextRefId}`;
      this.nextRefId += 1;
      const x = optionalJsonNumber(element.x);
      const y = optionalJsonNumber(element.y);
      const width = optionalJsonNumber(element.width);
      const height = optionalJsonNumber(element.height);
      this.refs.set(ref, {
        pageId,
        selector: element.selector,
        frame: snapshot.frame,
        frameUrl: snapshot.frameUrl,
        frameName: snapshot.frameName,
        x: x !== undefined && width !== undefined ? Math.round(x + width / 2) : x,
        y: y !== undefined && height !== undefined ? Math.round(y + height / 2) : y
      });
      return compactJsonObject({
        ...element,
        ref,
        frame_url: snapshot.frameUrl,
        frame_name: snapshot.frameName
      });
    })).slice(0, 800);
    const mainSnapshot = snapshots[0];

    return {
      page_id: pageId,
      filter,
      url: mainSnapshot?.url ?? page.url(),
      title: mainSnapshot?.title ?? (await page.title().catch(() => "")),
      text: this.snapshotText(snapshots),
      frames: snapshots.map((snapshot) => compactJsonObject({
        url: snapshot.url,
        title: snapshot.title,
        name: snapshot.frameName,
        text_length: snapshot.text.length,
        element_count: snapshot.elements.length,
        error: snapshot.error
      })),
      elements
    };
  }

  private async collectFrameSnapshots(page: ManagedPage): Promise<FrameSnapshot[]> {
    const frames = page.frames().slice(0, 20);
    const snapshots: FrameSnapshot[] = [];
    for (const frame of frames) {
      const box = frame === page.mainFrame()
        ? null
        : await frame.frameElement().then((element: any) => element.boundingBox()).catch(() => null);
      const offsetX = typeof box?.x === "number" ? box.x : 0;
      const offsetY = typeof box?.y === "number" ? box.y : 0;
      const frameUrl = String(frame.url?.() ?? "");
      const frameName = String(frame.name?.() ?? "");
      try {
        const snapshot = await frame.evaluate(({ offsetX, offsetY }: { offsetX: number; offsetY: number }) => {
          const interactiveSelector = "a,button,input,textarea,select,summary,iframe,[role='button'],[role='link'],[role='dialog'],[contenteditable='true'],[tabindex]";

          function cssPath(element: Element): string {
            if (element.id) {
              return `#${CSS.escape(element.id)}`;
            }

            const parts: string[] = [];
            let current: Element | null = element;
            while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
              let selector = current.nodeName.toLowerCase();
              const testId = current.getAttribute("data-testid");
              if (testId) {
                selector += `[data-testid="${CSS.escape(testId)}"]`;
                parts.unshift(selector);
                break;
              }

              const ariaLabel = current.getAttribute("aria-label");
              if (ariaLabel && parts.length === 0) {
                selector += `[aria-label="${CSS.escape(ariaLabel)}"]`;
              }

              const parent: Element | null = current.parentElement;
              if (parent) {
                const nodeName = current.nodeName;
                const siblings = (Array.from(parent.children) as Element[]).filter((sibling) => sibling.nodeName === nodeName);
                if (siblings.length > 1) {
                  selector += `:nth-of-type(${siblings.indexOf(current) + 1})`;
                }
              }
              parts.unshift(selector);
              current = parent;
            }
            return parts.join(" > ");
          }

          function elementText(element: Element): string {
            return (
              (element as HTMLElement).innerText ||
              element.getAttribute("aria-label") ||
              element.getAttribute("title") ||
              element.getAttribute("placeholder") ||
              element.getAttribute("value") ||
              element.textContent ||
              ""
            ).trim().slice(0, 500);
          }

          function collectOpenShadowRoots(root: Document | ShadowRoot, roots: ShadowRoot[]): void {
            const hosts = Array.from(root.querySelectorAll("*")).filter((element) => Boolean((element as HTMLElement).shadowRoot));
            for (const host of hosts) {
              const shadowRoot = (host as HTMLElement).shadowRoot;
              if (!shadowRoot || roots.includes(shadowRoot)) {
                continue;
              }
              roots.push(shadowRoot);
              collectOpenShadowRoots(shadowRoot, roots);
            }
          }

          const shadowRoots: ShadowRoot[] = [];
          collectOpenShadowRoots(document, shadowRoots);
          const roots: Array<Document | ShadowRoot> = [document, ...shadowRoots];
          const candidates: Element[] = [];
          for (const root of roots) {
            for (const element of Array.from(root.querySelectorAll(interactiveSelector))) {
              if (!candidates.includes(element)) {
                candidates.push(element);
              }
            }
          }

          const elements = candidates
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              const isFileInput =
                element.tagName.toLowerCase() === "input" &&
                (element.getAttribute("type") ?? "").toLowerCase() === "file";
              return isFileInput || (rect.width > 0 && rect.height > 0);
            })
            .slice(0, 250)
            .map((element, index) => {
              const rect = element.getBoundingClientRect();
              const geometry = rect.width > 0 && rect.height > 0
                ? {
                    x: Math.round(rect.x + offsetX),
                    y: Math.round(rect.y + offsetY),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                  }
                : {};
              return {
                index,
                selector: cssPath(element),
                tag: element.tagName.toLowerCase(),
                text: elementText(element),
                role: element.getAttribute("role") || "",
                href: element.getAttribute("href") || "",
                name: element.getAttribute("name") || "",
                type: element.getAttribute("type") || "",
                ...geometry
              };
            });

          const shadowText = shadowRoots
            .map((root) => (root.textContent || "").trim())
            .filter(Boolean)
            .join("\n");
          const text = [document.body?.innerText ?? "", shadowText].filter(Boolean).join("\n\n");
          return {
            url: location.href,
            title: document.title,
            text: text.slice(0, 50_000),
            elements
          };
        }, { offsetX, offsetY }) as { url: string; title: string; text: string; elements: FrameSnapshot["elements"] };
        snapshots.push({
          frame,
          frameUrl,
          frameName,
          url: snapshot.url,
          title: snapshot.title,
          text: snapshot.text,
          elements: snapshot.elements
        });
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        snapshots.push({
          frame,
          frameUrl,
          frameName,
          url: frameUrl,
          title: "",
          text: "",
          elements: [],
          error: detail
        });
      }
    }
    return snapshots;
  }

  private snapshotText(snapshots: FrameSnapshot[]): string {
    return snapshots
      .filter((snapshot) => snapshot.text)
      .map((snapshot, index) => {
        const label = index === 0 ? "Main frame" : `Frame ${index}`;
        return `[${label}: ${snapshot.url}]\n${snapshot.text}`;
      })
      .join("\n\n")
      .slice(0, 80_000);
  }

  private async ensureContext(): Promise<ManagedContext> {
    if (this.context) {
      try {
        this.context.pages();
        return this.context;
      } catch (error: unknown) {
        if (!isBrowserClosedError(error)) {
          throw error;
        }
        this.clearRuntimeState();
      }
    }

    if (!this.contextPromise) {
      this.contextPromise = this.launchContext().catch((error: unknown) => {
        this.contextPromise = null;
        throw error;
      });
    }

    return this.contextPromise;
  }

  private async launchContext(): Promise<ManagedContext> {
    try {
      this.playwright = await import("playwright");
    } catch {
      this.contextPromise = null;
      throw new Error("Playwright is not installed. Run `pnpm install` so the managed browser dependency is available.");
    }

    const existingContext = await this.connectToOpenProfileContext();
    if (existingContext) {
      return this.setContext(existingContext);
    }

    let context: ManagedContext;
    const viewportOptions = this.viewport
      ? {
          viewport: this.viewport,
          screen: this.viewport
        }
      : {
          viewport: null
        };
    try {
      context = await this.playwright.chromium.launchPersistentContext(this.userDataDir, {
        channel: this.browserChannel,
        headless: this.headless,
        ...viewportOptions
      });
    } catch (error: unknown) {
      if (isBrowserProfileInUseError(error)) {
        throw new ToolExecutionError(
          "busy",
          "This browser profile is already open in Chrome. Close that profile window, or reopen it from the latest Clero Local Agent so the daemon can attach to it.",
          { profile_dir: this.userDataDir }
        );
      }
      throw error;
    }

    return this.setContext(context);
  }

  private async connectToOpenProfileContext(): Promise<ManagedContext | null> {
    const endpoint = await this.existingProfileDebugEndpoint();
    if (!endpoint) {
      return null;
    }

    const browser = await this.playwright.chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => null);
      return null;
    }
    this.cdpBrowser = browser;
    return context;
  }

  private async existingProfileDebugEndpoint(): Promise<string | null> {
    if (this.removeUserDataDirOnDispose) {
      return null;
    }

    const endpoint = `http://127.0.0.1:${browserProfileDebugPort(this.userDataDir)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 350);
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: controller.signal });
      return response.ok ? endpoint : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private setContext(context: ManagedContext): ManagedContext {
    context.on?.("close", () => {
      if (this.context === context) {
        this.clearRuntimeState();
      }
    });
    context.on("page", (page: ManagedPage) => this.registerPage(page));
    for (const page of context.pages()) {
      this.registerPage(page);
    }

    this.context = context;
    this.contextPromise = null;
    return context;
  }

  private async ensurePage(pageId?: string): Promise<ManagedPage> {
    if (pageId) {
      return this.requirePage(pageId);
    }

    const context = await this.ensureContext();
    if (this.activePage && !this.activePage.isClosed()) {
      return this.activePage;
    }

    const existing = context.pages().find((page: ManagedPage) => !page.isClosed());
    if (existing) {
      this.activePage = existing;
      this.registerPage(existing);
      return existing;
    }

    return this.newPage();
  }

  private async pageForNavigation(pageId?: string): Promise<ManagedPage> {
    if (!pageId) {
      return this.ensurePage();
    }

    try {
      return await this.requirePage(pageId);
    } catch (error: unknown) {
      if (!isUnknownBrowserPageError(error)) {
        throw error;
      }
      return this.newPage();
    }
  }

  private async requirePage(pageId?: string): Promise<ManagedPage> {
    if (!pageId) {
      throw new Error("page_id is required");
    }

    await this.ensureContext();
    const page = this.pagesById.get(pageId);
    if (!page || page.isClosed()) {
      throw new Error(`Unknown browser page: ${pageId}`);
    }

    return page;
  }

  private async newPage(): Promise<ManagedPage> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    this.registerPage(page);
    this.activePage = page;
    return page;
  }

  private registerPage(page: ManagedPage): string {
    const existingId = this.pageIds.get(page);
    if (existingId) {
      return existingId;
    }

    const pageId = `page_${this.nextPageId}`;
    this.nextPageId += 1;
    this.pageIds.set(page, pageId);
    this.pagesById.set(pageId, page);
    this.consoleLogs.set(pageId, []);
    this.networkEvents.set(pageId, []);
    page.on?.("close", () => {
      if (this.activePage === page) {
        this.activePage = null;
      }
      this.pagesById.delete(pageId);
      this.consoleLogs.delete(pageId);
      this.networkEvents.delete(pageId);
      for (const [ref, target] of this.refs) {
        if (target.pageId === pageId) {
          this.refs.delete(ref);
        }
      }
    });
    page.on("console", (message: any) => {
      this.pushBounded(this.consoleLogs.get(pageId), {
        at: new Date().toISOString(),
        level: message.type(),
        text: message.text()
      });
    });
    page.on("request", (request: any) => {
      this.pushBounded(this.networkEvents.get(pageId), {
        at: new Date().toISOString(),
        type: "request",
        url: request.url(),
        method: request.method()
      });
    });
    page.on("response", (response: any) => {
      this.pushBounded(this.networkEvents.get(pageId), {
        at: new Date().toISOString(),
        type: "response",
        url: response.url(),
        status: response.status()
      });
    });
    page.on("requestfailed", (request: any) => {
      this.pushBounded(this.networkEvents.get(pageId), {
        at: new Date().toISOString(),
        type: "requestfailed",
        url: request.url(),
        method: request.method(),
        failure: request.failure()?.errorText
      });
    });
    return pageId;
  }

  private clearRuntimeState(): void {
    this.cdpBrowser = null;
    this.context = null;
    this.contextPromise = null;
    this.activePage = null;
    this.pagesById.clear();
    this.refs.clear();
    this.consoleLogs.clear();
    this.networkEvents.clear();
  }

  private pageId(page: ManagedPage): string {
    return this.registerPage(page);
  }

  private async describePage(page: ManagedPage): Promise<JsonObject> {
    return {
      page_id: this.pageId(page),
      active: this.activePage === page,
      url: page.url(),
      title: await page.title().catch(() => "")
    };
  }

  private resolveTarget(args: JsonObject, page: ManagedPage): BrowserRefTarget {
    const ref = optionalString(args, "ref");
    if (ref) {
      const target = this.refs.get(ref);
      if (!target) {
        throw new Error(`Unknown browser element ref: ${ref}`);
      }
      if (target.pageId !== this.pageId(page)) {
        throw new Error(`Element ref ${ref} belongs to ${target.pageId}, not ${this.pageId(page)}`);
      }
      return target;
    }

    const selector = optionalString(args, "selector");
    return { pageId: this.pageId(page), selector: selector ?? "" };
  }

  private pushBounded<T>(events: T[] | undefined, event: T, maxEvents = 500): void {
    if (!events) {
      return;
    }

    events.push(event);
    if (events.length > maxEvents) {
      events.splice(0, events.length - maxEvents);
    }
  }
}

function normalizeBrowserViewport(value: BrowserViewport | undefined): BrowserViewport | undefined {
  if (!value) {
    return undefined;
  }

  if (!Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width <= 0 || value.height <= 0) {
    return undefined;
  }

  return {
    width: value.width,
    height: value.height
  };
}

type ManagedBrowserSession = {
  agentId?: string;
  sessionId: string;
  adapter: BrowserAdapter;
};

export type AgentScopedManagedBrowserAdapterOptions = ManagedBrowserAdapterOptions & {
  sessionFactory?: (options: ManagedBrowserAdapterOptions) => BrowserAdapter;
};

export class AgentScopedManagedBrowserAdapter implements BrowserAdapter {
  private readonly profileRootDir: string;
  private readonly options: ManagedBrowserAdapterOptions;
  private readonly sessionFactory: (options: ManagedBrowserAdapterOptions) => BrowserAdapter;
  private readonly sessions = new Map<string, ManagedBrowserSession>();

  constructor(options: AgentScopedManagedBrowserAdapterOptions = {}) {
    const rememberSession = options.rememberSession !== false;
    this.profileRootDir = nonEmptyString(options.userDataDir) ?? path.join(os.homedir(), ".clero-local-agent", "browser-profile");
    this.options = {
      ...options,
      rememberSession
    };
    this.sessionFactory = options.sessionFactory ?? ((sessionOptions) => new ManagedBrowserAdapter(sessionOptions));
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.adapter.dispose?.()));
    this.sessions.clear();
  }

  async listTabs(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.listTabs(args));
  }

  async openUrl(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.openUrl(args));
  }

  async switchTab(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.switchTab(args));
  }

  async getPageContent(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.getPageContent(args));
  }

  async getInteractiveElements(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.getInteractiveElements(args));
  }

  async getSnapshot(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.getSnapshot(args));
  }

  async click(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.click(args));
  }

  async moveMouse(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.moveMouse(args));
  }

  async mouseDown(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.mouseDown(args));
  }

  async mouseUp(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.mouseUp(args));
  }

  async drag(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.drag(args));
  }

  async type(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.type(args));
  }

  async fill(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.fill(args));
  }

  async uploadFile(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => {
      if (!adapter.uploadFile) {
        throw new ToolExecutionError("tool_failed", "Browser file uploads are unavailable for this browser provider.");
      }
      return adapter.uploadFile(args);
    });
  }

  async pressKey(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.pressKey(args));
  }

  async screenshot(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.screenshot(args));
  }

  async getConsoleLogs(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.getConsoleLogs(args));
  }

  async getNetworkEvents(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.getNetworkEvents(args));
  }

  async closeTab(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.closeTab(args));
  }

  async goBack(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.goBack(args));
  }

  async goForward(args: JsonObject, context?: ToolExecutionContext): Promise<JsonObject> {
    return this.withSession(context, (adapter) => adapter.goForward(args));
  }

  private async withSession(
    context: ToolExecutionContext | undefined,
    run: (adapter: BrowserAdapter) => Promise<JsonObject>
  ): Promise<JsonObject> {
    let session = this.sessionForContext(context);
    let result: JsonObject;
    try {
      result = await run(session.adapter);
    } catch (error: unknown) {
      if (!isBrowserClosedError(error)) {
        throw error;
      }

      await session.adapter.dispose?.().catch(() => null);
      this.sessions.delete(session.sessionId);
      session = this.sessionForContext(context);
      result = await run(session.adapter);
    }
    return compactJsonObject({
      ...result,
      browser_session_id: session.sessionId,
      agent_id: session.agentId
    });
  }

  private sessionForContext(context?: ToolExecutionContext): ManagedBrowserSession {
    const agentId = nonEmptyString(context?.agentId);
    const sessionId = agentId ? `agent-${safePathSegment(agentId)}` : "default";
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const adapter = this.sessionFactory({
      ...this.options,
      userDataDir:
        this.options.rememberSession === false
          ? undefined
          : path.join(this.profileRootDir, sessionId)
    });
    const session = { agentId, sessionId, adapter };
    this.sessions.set(sessionId, session);
    return session;
  }
}

export type StreamableHttpMcpClientOptions = {
  endpointUrl: string;
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
};

export class StreamableHttpMcpClient implements McpToolClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly endpointUrl: string;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly protocolVersion: string;

  constructor(options: StreamableHttpMcpClientOptions) {
    this.endpointUrl = options.endpointUrl;
    this.clientName = options.clientName ?? "clero-local-agent";
    this.clientVersion = options.clientVersion ?? "0.1.0";
    this.protocolVersion = options.protocolVersion ?? "2025-06-18";
  }

  async callTool(name: string, args: JsonObject): Promise<JsonValue> {
    await this.ensureInitialized();
    return this.request("tools/call", {
      name,
      arguments: args
    });
  }

  async listTools(): Promise<JsonValue> {
    await this.ensureInitialized();
    return this.request("tools/list", {});
  }

  private async ensureInitialized(): Promise<void> {
    this.initializePromise ??= (async () => {
      await this.request("initialize", {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: {
          name: this.clientName,
          version: this.clientVersion
        }
      });
      await this.notify("notifications/initialized", {});
    })();

    await this.initializePromise;
  }

  private async notify(method: string, params: JsonObject): Promise<void> {
    await this.post({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  private async request(method: string, params: JsonObject): Promise<JsonValue> {
    const id = this.nextId;
    this.nextId += 1;
    const response = await this.post({
      jsonrpc: "2.0",
      id,
      method,
      params
    });

    if (response === null) {
      return null;
    }

    if (!isJsonObject(response)) {
      throw new Error(`MCP server returned a non-object response for ${method}`);
    }

    const jsonRpcResponse = response as JsonRpcResponse;
    if (jsonRpcResponse.error) {
      throw new Error(jsonRpcResponse.error.message ?? `MCP request failed: ${method}`);
    }

    return jsonRpcResponse.result ?? null;
  }

  private async post(payload: JsonObject): Promise<JsonValue> {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": this.protocolVersion
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const response = await fetch(this.endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) {
      this.sessionId = sessionId;
    }

    if (!response.ok) {
      throw new Error(`MCP server returned HTTP ${response.status}`);
    }

    if (response.status === 202 || response.status === 204) {
      return null;
    }

    const body = await response.text();
    if (!body.trim()) {
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return parseSseJson(body);
    }

    return JSON.parse(body) as JsonValue;
  }
}

type PendingStdioRequest = {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type StdioMcpClientOptions = {
  command?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
  requestTimeoutMs?: number;
};

export class StdioMcpClient implements McpToolClient {
  private nextId = 1;
  private child: ChildProcessWithoutNullStreams | null = null;
  private initializePromise: Promise<void> | null = null;
  private stdoutBuffer = "";
  private stderrTail = "";
  private readonly pending = new Map<number, PendingStdioRequest>();
  private readonly command: string;
  private readonly args: string[];
  private readonly env?: Record<string, string | undefined>;
  private readonly cwd?: string;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly protocolVersion: string;
  private readonly requestTimeoutMs: number;

  constructor(options: StdioMcpClientOptions = {}) {
    this.command = options.command ?? "npx";
    this.args = options.args ?? [
      "-y",
      "chrome-devtools-mcp@latest",
      "--no-usage-statistics",
      "--no-performance-crux"
    ];
    this.env = options.env;
    this.cwd = options.cwd;
    this.clientName = options.clientName ?? "clero-local-agent";
    this.clientVersion = options.clientVersion ?? "0.1.0";
    this.protocolVersion = options.protocolVersion ?? "2025-06-18";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  async callTool(name: string, args: JsonObject): Promise<JsonValue> {
    await this.ensureInitialized();
    return this.request("tools/call", {
      name,
      arguments: args
    });
  }

  async listTools(): Promise<JsonValue> {
    await this.ensureInitialized();
    return this.request("tools/list", {});
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.initializePromise = null;
    this.rejectPending(new Error("MCP stdio client was disposed"));
    child?.kill();
  }

  private async ensureInitialized(): Promise<void> {
    this.initializePromise ??= (async () => {
      await this.request("initialize", {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: {
          name: this.clientName,
          version: this.clientVersion
        }
      });
      this.notify("notifications/initialized", {});
    })();

    await this.initializePromise;
  }

  private notify(method: string, params: JsonObject): void {
    this.write({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  private async request(method: string, params: JsonObject): Promise<JsonValue> {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise<JsonValue>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP stdio request timed out: ${method}${this.stderrSummary()}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.write({
          jsonrpc: "2.0",
          id,
          method,
          params
        });
      } catch (error: unknown) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(payload: JsonObject): void {
    const child = this.ensureChild();
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child;
    }

    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
        ...this.env
      },
      stdio: "pipe"
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
    });
    child.on("error", (error) => {
      this.child = null;
      this.initializePromise = null;
      this.rejectPending(new Error(`Failed to start MCP stdio command: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      this.child = null;
      this.initializePromise = null;
      this.rejectPending(new Error(`MCP stdio command exited with code ${code ?? "null"} signal ${signal ?? "null"}${this.stderrSummary()}`));
    });

    return child;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleStdoutLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleStdoutLine(line: string): void {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(line) as JsonValue;
    } catch {
      this.stderrTail = `${this.stderrTail}\n${line}`.slice(-4000);
      return;
    }

    if (!isJsonObject(parsed) || parsed.id === undefined || parsed.id === null) {
      return;
    }

    const id = Number(parsed.id);
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    this.pending.delete(id);
    clearTimeout(pending.timeout);

    const response = parsed as JsonRpcResponse;
    if (response.error) {
      pending.reject(new Error(response.error.message ?? `MCP stdio request failed for id ${id}`));
      return;
    }

    pending.resolve(response.result ?? null);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private stderrSummary(): string {
    const detail = this.stderrTail.trim();
    return detail ? `: ${detail}` : "";
  }
}

export type ChromeDevToolsBrowserDebugAdapterOptions = {
  client?: McpToolClient;
  command?: string;
  args?: string[];
  browserUrl?: string;
  env?: Record<string, string | undefined>;
  requestTimeoutMs?: number;
};

export class ChromeDevToolsBrowserDebugAdapter implements BrowserDebugAdapter {
  private readonly client: McpToolClient & { dispose?: () => Promise<void> };

  constructor(options: ChromeDevToolsBrowserDebugAdapterOptions = {}) {
    if (options.client) {
      this.client = options.client;
      return;
    }

    this.client = new StdioMcpClient({
      command: options.command,
      args: chromeDevToolsMcpArgs(options.args, options.browserUrl),
      env: options.env,
      requestTimeoutMs: options.requestTimeoutMs
    });
  }

  async dispose(): Promise<void> {
    await this.client.dispose?.();
  }

  async listTools(): Promise<JsonObject> {
    return normalizeMcpToolResult(await this.client.listTools());
  }

  async callTool(args: JsonObject): Promise<JsonObject> {
    const name = requiredString(args, "name");
    const toolArgs = isJsonObject(args.arguments) ? args.arguments : {};
    return normalizeMcpToolResult(await this.client.callTool(name, toolArgs));
  }
}

function chromeDevToolsMcpArgs(args: string[] | undefined, browserUrl: string | undefined): string[] {
  const resolved = args ?? [
    "-y",
    "chrome-devtools-mcp@latest",
    "--no-usage-statistics",
    "--no-performance-crux"
  ];
  if (!browserUrl || resolved.some((item) => item.startsWith("--browser-url"))) {
    return resolved;
  }
  return [...resolved, `--browser-url=${browserUrl}`];
}

export type McpChromeBrowserAdapterOptions = {
  endpointUrl?: string;
  client?: McpToolClient;
};

export class McpChromeBrowserAdapter implements BrowserAdapter {
  private readonly client: McpToolClient;

  constructor(options: McpChromeBrowserAdapterOptions = {}) {
    if (options.client) {
      this.client = options.client;
      return;
    }
    if (!options.endpointUrl) {
      throw new Error("mcp-chrome endpointUrl is required.");
    }
    this.client = new StreamableHttpMcpClient({ endpointUrl: options.endpointUrl });
  }

  async listTools(): Promise<JsonObject> {
    return normalizeMcpToolResult(await this.client.listTools());
  }

  async listTabs(args: JsonObject): Promise<JsonObject> {
    return this.callJsonTool("get_windows_and_tabs", args);
  }

  async openUrl(args: JsonObject): Promise<JsonObject> {
    const url = webUrlArg(args, "url");
    return this.callJsonTool("chrome_navigate", compactJsonObject({
      url,
      newWindow: optionalBoolean(args, "new_window") ?? optionalBoolean(args, "newWindow"),
      tabId: optionalTabId(args),
      background: optionalBoolean(args, "background"),
      width: optionalNumber(args, "width"),
      height: optionalNumber(args, "height")
    }));
  }

  async switchTab(args: JsonObject): Promise<JsonObject> {
    return this.callJsonTool("chrome_switch_tab", compactJsonObject({
      tabId: requiredTabId(args),
      windowId: optionalWindowId(args)
    }));
  }

  async getPageContent(args: JsonObject): Promise<JsonObject> {
    return this.callJsonTool("chrome_get_web_content", compactJsonObject({
      format: optionalString(args, "format") ?? "text",
      selector: optionalString(args, "selector"),
      tabId: optionalTabId(args),
      background: optionalBoolean(args, "background")
    }));
  }

  async getInteractiveElements(args: JsonObject): Promise<JsonObject> {
    return this.callJsonTool("chrome_read_page", compactJsonObject({
      filter: optionalString(args, "filter") ?? "interactive",
      tabId: optionalTabId(args)
    }));
  }

  async getSnapshot(args: JsonObject): Promise<JsonObject> {
    return this.callJsonTool("chrome_read_page", compactJsonObject({
      filter: optionalString(args, "filter"),
      tabId: optionalTabId(args)
    }));
  }

  async click(args: JsonObject): Promise<JsonObject> {
    return this.callJsonTool("chrome_click_element", compactJsonObject({
      ref: optionalString(args, "ref"),
      selector: optionalString(args, "selector"),
      coordinates: coordinatesArg(args)
    }));
  }

  async moveMouse(args: JsonObject): Promise<JsonObject> {
    return this.callJsonTool("chrome_computer", {
      action: "move_mouse",
      x: requiredNumber(args, "x"),
      y: requiredNumber(args, "y"),
      steps: boundedOptionalNumber(args, "steps", 1, 100) ?? 1
    });
  }

  async mouseDown(args: JsonObject): Promise<JsonObject> {
    return this.callJsonTool("chrome_computer", {
      action: "mouse_down",
      button: mouseButtonArg(args)
    });
  }

  async mouseUp(args: JsonObject): Promise<JsonObject> {
    return this.callJsonTool("chrome_computer", {
      action: "mouse_up",
      button: mouseButtonArg(args)
    });
  }

  async drag(args: JsonObject): Promise<JsonObject> {
    return this.callJsonTool("chrome_computer", {
      action: "drag",
      from_x: requiredNumber(args, "from_x"),
      from_y: requiredNumber(args, "from_y"),
      to_x: requiredNumber(args, "to_x"),
      to_y: requiredNumber(args, "to_y"),
      steps: boundedOptionalNumber(args, "steps", 1, 100) ?? 10,
      button: mouseButtonArg(args)
    });
  }

  async type(args: JsonObject): Promise<JsonObject> {
    const text = requiredText(args);
    const ref = optionalString(args, "ref");
    const selector = optionalString(args, "selector");
    if (ref || selector) {
      await this.callJsonTool("chrome_click_element", compactJsonObject({ ref, selector }));
      await this.callJsonTool("chrome_computer", {
        action: "type",
        text
      });
      return compactJsonObject({
        typed: true,
        ref,
        selector,
        length: text.length
      });
    }

    return this.callJsonTool("chrome_computer", {
      action: "type",
      text
    });
  }

  async fill(args: JsonObject): Promise<JsonObject> {
    const text = requiredText(args);
    const ref = optionalString(args, "ref");
    const selector = optionalString(args, "selector");
    if (!ref && !selector) {
      throw new ToolExecutionError("invalid_arguments", "ref or selector is required");
    }

    return this.callJsonTool(
      "chrome_fill_or_select",
      compactJsonObject({
        ref,
        selector,
        value: text
      })
    );
  }

  async pressKey(args: JsonObject): Promise<JsonObject> {
    return this.callJsonTool("chrome_keyboard", compactJsonObject({
      keys: requiredString(args, "key"),
      selector: optionalString(args, "selector"),
      delay: optionalNumber(args, "delay")
    }));
  }

  async screenshot(args: JsonObject): Promise<JsonObject> {
    return this.callJsonTool("chrome_screenshot", compactJsonObject({
      name: optionalString(args, "name"),
      selector: optionalString(args, "selector"),
      tabId: optionalTabId(args),
      background: optionalBoolean(args, "background"),
      width: optionalNumber(args, "width"),
      height: optionalNumber(args, "height"),
      storeBase64: optionalBoolean(args, "store_base64") ?? true,
      fullPage: optionalBoolean(args, "full_page") ?? optionalBoolean(args, "fullPage")
    }));
  }

  async getConsoleLogs(args: JsonObject): Promise<JsonObject> {
    return this.callJsonTool("chrome_console", compactJsonObject({
      tabId: optionalTabId(args)
    }));
  }

  async getNetworkEvents(args: JsonObject): Promise<JsonObject> {
    const action = optionalString(args, "action") ?? "stop";
    if (action === "start") {
      return this.callJsonTool("chrome_network_capture_start", compactJsonObject({
        url: optionalString(args, "url"),
        maxCaptureTime: optionalNumber(args, "max_capture_time") ?? optionalNumber(args, "maxCaptureTime"),
        inactivityTimeout: optionalNumber(args, "inactivity_timeout") ?? optionalNumber(args, "inactivityTimeout"),
        includeStatic: optionalBoolean(args, "include_static") ?? optionalBoolean(args, "includeStatic")
      }));
    }

    return this.callJsonTool("chrome_network_capture_stop", {});
  }

  async closeTab(args: JsonObject): Promise<JsonObject> {
    const tabId = optionalTabId(args);
    const windowId = optionalWindowId(args);
    if (tabId || windowId) {
      return this.callJsonTool("chrome_close_tabs", compactJsonObject({
        tabIds: tabId ? [tabId] : undefined,
        windowIds: windowId ? [windowId] : undefined
      }));
    }

    const activeTabId = findActiveTabId(await this.listTabs({}));
    if (!activeTabId) {
      throw new Error("No active browser tab found to close");
    }

    return this.callJsonTool("chrome_close_tabs", {
      tabIds: [activeTabId]
    });
  }

  async goBack(args: JsonObject): Promise<JsonObject> {
    return this.goBackOrForward(args, "back");
  }

  async goForward(args: JsonObject): Promise<JsonObject> {
    return this.goBackOrForward(args, "forward");
  }

  private async goBackOrForward(args: JsonObject, direction: "back" | "forward"): Promise<JsonObject> {
    return this.callJsonTool("chrome_go_back_or_forward", compactJsonObject({
      direction,
      tabId: optionalTabId(args)
    }));
  }

  private async callJsonTool(name: string, args: JsonObject): Promise<JsonObject> {
    return normalizeMcpToolResult(await this.client.callTool(name, args));
  }
}

function normalizeMcpToolResult(result: JsonValue): JsonObject {
  if (!isJsonObject(result)) {
    return { value: result };
  }

  if (result.isError === true) {
    const message = extractMcpText(result) ?? "MCP tool failed";
    throw new Error(message);
  }

  const text = extractMcpText(result);
  if (!text) {
    return result;
  }

  try {
    const parsed = JSON.parse(text) as JsonValue;
    return isJsonObject(parsed) ? parsed : { value: parsed };
  } catch {
    return { text };
  }
}

function extractMcpText(result: JsonObject): string | null {
  const content = result.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const textParts = content
    .filter(isJsonObject)
    .map((item) => item.text)
    .filter((text): text is string => typeof text === "string");
  return textParts.length > 0 ? textParts.join("\n") : null;
}

function parseSseJson(body: string): JsonValue {
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
      .trim();

    if (data && data !== "[DONE]") {
      return JSON.parse(data) as JsonValue;
    }
  }

  throw new Error("MCP server returned an empty event stream");
}

function requiredString(args: JsonObject, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function webUrlArg(args: JsonObject, key: string): string {
  const value = requiredString(args, key).trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ToolExecutionError("invalid_arguments", `${key} must be a valid HTTP or HTTPS URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ToolExecutionError("invalid_arguments", `${key} must use http or https`);
  }

  return value;
}

function optionalString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "unknown";
}

function optionalBoolean(args: JsonObject, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalNumber(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalJsonNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedOptionalNumber(args: JsonObject, key: string, min: number, max: number): number | undefined {
  const value = optionalNumber(args, key);
  if (value === undefined) {
    return undefined;
  }
  return Math.min(max, Math.max(min, value));
}

function openUrlWaitUntil(args: JsonObject): "commit" | "domcontentloaded" | "load" | "networkidle" {
  const value = optionalString(args, "wait_until") ?? optionalString(args, "waitUntil");
  if (value === "commit" || value === "domcontentloaded" || value === "load" || value === "networkidle") {
    return value;
  }
  return "load";
}

function mouseButtonArg(args: JsonObject): "left" | "right" | "middle" {
  const value = optionalString(args, "button");
  if (value === "left" || value === "right" || value === "middle") {
    return value;
  }
  return "left";
}

function requiredNumber(args: JsonObject, key: string): number {
  const value = optionalNumber(args, key);
  if (value === undefined) {
    throw new Error(`${key} must be a finite number`);
  }

  return value;
}

function optionalNumberLike(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function optionalTabId(args: JsonObject): number | undefined {
  return optionalNumberLike(args, "tab_id") ?? optionalNumberLike(args, "tabId") ?? optionalNumberLike(args, "page_id");
}

function pageIdArg(args: JsonObject): string | undefined {
  const pageId = optionalString(args, "page_id") ?? optionalString(args, "pageId");
  if (pageId) {
    return pageId;
  }

  const tabId = args.tab_id ?? args.tabId;
  if (typeof tabId === "string") {
    return tabId;
  }

  return undefined;
}

function requiredTabId(args: JsonObject): number {
  const tabId = optionalTabId(args);
  if (!tabId) {
    throw new Error("tab_id is required");
  }

  return tabId;
}

function optionalWindowId(args: JsonObject): number | undefined {
  return optionalNumberLike(args, "window_id") ?? optionalNumberLike(args, "windowId");
}

function requiredText(args: JsonObject): string {
  const text = optionalString(args, "text") ?? optionalString(args, "value");
  if (!text) {
    throw new Error("text is required");
  }

  return text;
}

function browserUploadFilePaths(args: JsonObject): string[] {
  const values: string[] = [];
  const filePath = nonEmptyString(optionalString(args, "file_path"));
  if (filePath) {
    values.push(filePath);
  }
  const filePaths = args.file_paths;
  if (Array.isArray(filePaths)) {
    for (const value of filePaths) {
      if (typeof value !== "string" || !value.trim()) {
        throw new ToolExecutionError("invalid_arguments", "file_paths must contain only non-empty strings");
      }
      values.push(value.trim());
    }
  }

  const uniquePaths = [...new Set(values)];
  if (uniquePaths.length === 0) {
    throw new ToolExecutionError("invalid_arguments", "file_path or file_paths is required");
  }
  if (uniquePaths.length > 20) {
    throw new ToolExecutionError("invalid_arguments", "A maximum of 20 files can be uploaded at once");
  }
  return uniquePaths;
}

function coordinatesArg(args: JsonObject): JsonObject | undefined {
  const coordinates = args.coordinates;
  if (isJsonObject(coordinates)) {
    return coordinates;
  }

  const x = optionalNumber(args, "x");
  const y = optionalNumber(args, "y");
  if (x === undefined || y === undefined) {
    return undefined;
  }

  return { x, y };
}

function browserProfileDebugPort(profileDir: string): number {
  let hash = 2_166_136_261;
  for (const byte of Buffer.from(profileDir, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return 40_000 + (hash % 20_000);
}

function isBrowserProfileInUseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Opening in existing browser session") || message.includes("SingletonLock");
}

function isBrowserClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("browser is closed") ||
    normalized.includes("browser has been closed") ||
    normalized.includes("target page, context or browser has been closed") ||
    normalized.includes("browsercontext has been closed") ||
    normalized.includes("target closed")
  );
}

function isUnknownBrowserPageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Unknown browser page:");
}

function compactJsonObject(values: Record<string, JsonValue | undefined>): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

function findActiveTabId(tabsResult: JsonObject): number | null {
  const windows = tabsResult.windows;
  if (!Array.isArray(windows)) {
    return null;
  }

  for (const window of windows) {
    if (!isJsonObject(window) || !Array.isArray(window.tabs)) {
      continue;
    }

    for (const tab of window.tabs) {
      if (isJsonObject(tab) && tab.active === true && typeof tab.tabId === "number") {
        return tab.tabId;
      }
    }
  }

  return null;
}
