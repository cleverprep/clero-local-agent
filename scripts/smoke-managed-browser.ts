import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import process from "node:process";
import path from "node:path";
import { StaticApprovalProvider } from "../packages/approvals/src/index.ts";
import { BrowserTools, ManagedBrowserAdapter } from "../packages/browser/src/index.ts";
import { WorkspacePolicy } from "../packages/workspace/src/index.ts";

const configuredProfileDir = process.env.CLERO_BROWSER_PROFILE_DIR;
const adapter = new ManagedBrowserAdapter({
  userDataDir: configuredProfileDir,
  rememberSession: Boolean(configuredProfileDir),
  headless: process.env.CLERO_BROWSER_HEADLESS === "true",
  browserChannel: browserChannelArg(process.env.CLERO_BROWSER_CHANNEL)
});
const workspacePolicy = new WorkspacePolicy({
  allowedDirectories: [process.cwd()],
  allowedFileDirectories: [os.tmpdir(), "/tmp"]
});
const browserTools = new BrowserTools(adapter, {
  approvalProvider: new StaticApprovalProvider(true, "Approved managed-browser smoke upload"),
  resolveFilePath: (filePath) => workspacePolicy.resolveAllowedFile(filePath)
});
const uploadTool = browserTools
  .definitions()
  .find((definition) => definition.name === "browser.upload_file");
const fixtureHtml = `
  <!doctype html>
  <title>Clero Managed Browser Smoke</title>
  <input id="q" aria-label="Query" />
  <input id="attachment" type="file" hidden accept="video/*" onchange="document.querySelector('#upload').textContent = this.files[0]?.name || ''" />
  <button id="go" onclick="document.body.dataset.clicked = 'yes'; document.querySelector('#result').textContent = document.querySelector('#q').value">Go</button>
  <div id="result"></div>
  <div id="upload"></div>
`;
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(fixtureHtml);
});

async function main(): Promise<void> {
  const uploadFixtureDir = await mkdtemp(path.join(os.tmpdir(), "clero-browser-upload-smoke-"));
  const uploadFixturePath = path.join(uploadFixtureDir, "founder-video.mp4");

  try {
    await writeFile(uploadFixturePath, "synthetic video fixture");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Managed browser smoke server did not expose a TCP address");
    }

    console.log("Checking managed browser provider");
    const opened = await adapter.openUrl({
      url: `http://127.0.0.1:${address.port}/`
    });
    const snapshot = await adapter.getSnapshot({});
    const uploadInput = Array.isArray(snapshot.elements)
      ? snapshot.elements.find((element) =>
          isRecord(element) &&
          element.selector === "#attachment" &&
          element.type === "file"
        )
      : undefined;
    const uploadRef = isRecord(uploadInput) && typeof uploadInput.ref === "string" ? uploadInput.ref : undefined;
    if (!uploadRef) {
      throw new Error("Hidden file input was not discoverable in the browser snapshot");
    }
    if (!uploadTool) {
      throw new Error("browser.upload_file was not registered for the managed browser smoke test");
    }
    await adapter.type({ selector: "#q", text: "hello from clero" });
    await adapter.click({ selector: "#go" });
    await uploadTool.handler(
      {
        ref: uploadRef,
        file_path: uploadFixturePath,
        expected_url: opened.url
      },
      { requestId: "managed_browser_smoke_upload" }
    );
    const content = await adapter.getPageContent({});
    const tabs = await adapter.listTabs({});
    const contentHasUpload = typeof content.content === "string" && content.content.includes("founder-video.mp4");
    if (!contentHasUpload) {
      throw new Error("Managed browser did not retain the selected upload file");
    }
    console.log("browser.list_tabs ok");
    console.log(JSON.stringify({
      page_count: Array.isArray(tabs.pages) ? tabs.pages.length : 0,
      snapshot_title: snapshot.title,
      interactive_elements: Array.isArray(snapshot.elements) ? snapshot.elements.length : 0,
      hidden_file_input_discoverable: true,
      uploaded_file_from_system_temp: true,
      content_has_typed_text: typeof content.content === "string" && content.content.includes("hello from clero"),
      content_has_upload: contentHasUpload
    }, null, 2));
  } finally {
    await adapter.dispose();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    await rm(uploadFixtureDir, { recursive: true, force: true });
  }
}

function browserChannelArg(value: string | undefined): "chromium" | "chrome" | "chrome-beta" | "msedge" | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "chromium" || value === "chrome" || value === "chrome-beta" || value === "msedge") {
    return value;
  }

  throw new Error("CLERO_BROWSER_CHANNEL must be chromium, chrome, chrome-beta, or msedge");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`managed browser smoke test failed: ${message}`);
  process.exitCode = 1;
});
