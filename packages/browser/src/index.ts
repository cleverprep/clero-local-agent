import os from "node:os";
import path from "node:path";
import { ToolExecutionError, type ToolDefinition } from "@clero-local-agent/mcp-runtime";
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
  listTabs(args: JsonObject): Promise<JsonObject>;
  openUrl(args: JsonObject): Promise<JsonObject>;
  switchTab(args: JsonObject): Promise<JsonObject>;
  getPageContent(args: JsonObject): Promise<JsonObject>;
  getInteractiveElements(args: JsonObject): Promise<JsonObject>;
  getSnapshot(args: JsonObject): Promise<JsonObject>;
  click(args: JsonObject): Promise<JsonObject>;
  moveMouse(args: JsonObject): Promise<JsonObject>;
  mouseDown(args: JsonObject): Promise<JsonObject>;
  mouseUp(args: JsonObject): Promise<JsonObject>;
  drag(args: JsonObject): Promise<JsonObject>;
  type(args: JsonObject): Promise<JsonObject>;
  pressKey(args: JsonObject): Promise<JsonObject>;
  screenshot(args: JsonObject): Promise<JsonObject>;
  getConsoleLogs(args: JsonObject): Promise<JsonObject>;
  getNetworkEvents(args: JsonObject): Promise<JsonObject>;
  closeTab(args: JsonObject): Promise<JsonObject>;
  goBack(args: JsonObject): Promise<JsonObject>;
  goForward(args: JsonObject): Promise<JsonObject>;
}

export interface McpToolClient {
  callTool(name: string, args: JsonObject): Promise<JsonValue>;
  listTools(): Promise<JsonValue>;
}

export class BrowserTools {
  private readonly adapter: BrowserAdapter;

  constructor(adapter: BrowserAdapter) {
    this.adapter = adapter;
  }

  definitions(): ToolDefinition[] {
    return [
      {
        name: "browser.list_tabs",
        description: "List pages in the local managed browser session.",
        handler: (args) => this.adapter.listTabs(args)
      },
      {
        name: "browser.open_url",
        description: "Open a URL in the local managed browser session.",
        handler: (args) => this.adapter.openUrl(args)
      },
      {
        name: "browser.switch_tab",
        description: "Switch to an existing browser tab.",
        handler: (args) => this.adapter.switchTab(args)
      },
      {
        name: "browser.get_page_content",
        description: "Extract visible page text or HTML from the active tab.",
        handler: (args) => this.adapter.getPageContent(args)
      },
      {
        name: "browser.get_interactive_elements",
        description: "Read interactive elements from the active page.",
        handler: (args) => this.adapter.getInteractiveElements(args)
      },
      {
        name: "browser.get_snapshot",
        description: "Read an accessibility-like page snapshot.",
        handler: (args) => this.adapter.getSnapshot(args)
      },
      {
        name: "browser.click",
        description: "Click a page element by ref, selector, or coordinates.",
        handler: (args) => this.adapter.click(args)
      },
      {
        name: "browser.move_mouse",
        description: "Move the mouse pointer to page coordinates.",
        handler: (args) => this.adapter.moveMouse(args)
      },
      {
        name: "browser.mouse_down",
        description: "Press and hold a mouse button.",
        handler: (args) => this.adapter.mouseDown(args)
      },
      {
        name: "browser.mouse_up",
        description: "Release a mouse button.",
        handler: (args) => this.adapter.mouseUp(args)
      },
      {
        name: "browser.drag",
        description: "Drag from one page coordinate to another.",
        handler: (args) => this.adapter.drag(args)
      },
      {
        name: "browser.type",
        description: "Type text, or fill a targeted field when a ref or selector is provided.",
        handler: (args) => this.adapter.type(args)
      },
      {
        name: "browser.press_key",
        description: "Press a keyboard key or shortcut in the browser.",
        handler: (args) => this.adapter.pressKey(args)
      },
      {
        name: "browser.screenshot",
        description: "Capture a screenshot from the active tab.",
        handler: (args) => this.adapter.screenshot(args)
      },
      {
        name: "browser.get_console_logs",
        description: "Return captured console output from the active tab.",
        handler: (args) => this.adapter.getConsoleLogs(args)
      },
      {
        name: "browser.get_network_events",
        description: "Return captured browser network events.",
        handler: (args) => this.adapter.getNetworkEvents(args)
      },
      {
        name: "browser.go_back",
        description: "Navigate the active tab back.",
        handler: (args) => this.adapter.goBack(args)
      },
      {
        name: "browser.go_forward",
        description: "Navigate the active tab forward.",
        handler: (args) => this.adapter.goForward(args)
      },
      {
        name: "browser.close_tab",
        description: "Close the active or selected browser tab.",
        handler: (args) => this.adapter.closeTab(args)
      },
      {
        name: "browser.close_page",
        description: "Compatibility alias for browser.close_tab.",
        handler: (args) => this.adapter.closeTab(args)
      }
    ];
  }
}

export type ManagedBrowserAdapterOptions = {
  userDataDir?: string;
  headless?: boolean;
  browserChannel?: "chromium" | "chrome" | "chrome-beta" | "msedge";
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
  private readonly headless: boolean;
  private readonly browserChannel?: string;
  private playwright: PlaywrightModule | null = null;
  private context: ManagedContext | null = null;
  private contextPromise: Promise<ManagedContext> | null = null;
  private activePage: ManagedPage | null = null;
  private nextPageId = 1;
  private nextRefId = 1;
  private readonly pagesById = new Map<string, ManagedPage>();
  private readonly pageIds = new WeakMap<object, string>();
  private readonly refs = new Map<string, BrowserRefTarget>();
  private readonly consoleLogs = new Map<string, BrowserLogEvent[]>();
  private readonly networkEvents = new Map<string, BrowserNetworkEvent[]>();

  constructor(options: ManagedBrowserAdapterOptions = {}) {
    this.userDataDir = options.userDataDir ?? path.join(os.homedir(), ".clero-local-agent", "browser-profile");
    this.headless = options.headless ?? false;
    this.browserChannel = options.browserChannel === "chromium" ? undefined : options.browserChannel;
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
    await context?.close();
    this.context = null;
    this.contextPromise = null;
    this.activePage = null;
    this.pagesById.clear();
    this.refs.clear();
    this.consoleLogs.clear();
    this.networkEvents.clear();
  }

  async openUrl(args: JsonObject): Promise<JsonObject> {
    const url = webUrlArg(args, "url");
    const waitUntil = openUrlWaitUntil(args);
    const timeoutMs = boundedOptionalNumber(args, "timeout_ms", 1_000, 120_000) ?? 30_000;
    const settleMs = boundedOptionalNumber(args, "settle_ms", 0, 30_000) ?? 5_000;
    const page = optionalBoolean(args, "new_tab") || optionalBoolean(args, "new_window")
      ? await this.newPage()
      : await this.ensurePage(pageIdArg(args));
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
      await locator.fill(text, { timeout: 10_000 }).catch(async () => {
        await locator.click({ timeout: 10_000 });
        await page.keyboard.type(text);
      });
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
              return rect.width > 0 && rect.height > 0;
            })
            .slice(0, 250)
            .map((element, index) => {
              const rect = element.getBoundingClientRect();
              return {
                index,
                selector: cssPath(element),
                tag: element.tagName.toLowerCase(),
                text: elementText(element),
                role: element.getAttribute("role") || "",
                href: element.getAttribute("href") || "",
                name: element.getAttribute("name") || "",
                type: element.getAttribute("type") || "",
                x: Math.round(rect.x + offsetX),
                y: Math.round(rect.y + offsetY),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
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
      return this.context;
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

    const context = await this.playwright.chromium.launchPersistentContext(this.userDataDir, {
      channel: this.browserChannel,
      headless: this.headless,
      viewport: null
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
      return this.callJsonTool("chrome_fill_or_select", compactJsonObject({
        ref,
        selector,
        value: text
      }));
    }

    return this.callJsonTool("chrome_computer", {
      action: "type",
      text
    });
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
