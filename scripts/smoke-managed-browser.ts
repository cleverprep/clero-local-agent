import process from "node:process";
import { ManagedBrowserAdapter } from "../packages/browser/src/index.ts";

const adapter = new ManagedBrowserAdapter({
  userDataDir: process.env.CLERO_BROWSER_PROFILE_DIR,
  headless: process.env.CLERO_BROWSER_HEADLESS === "true",
  browserChannel: browserChannelArg(process.env.CLERO_BROWSER_CHANNEL)
});

async function main(): Promise<void> {
  try {
    console.log("Checking managed browser provider");
    await adapter.openUrl({
      url: `data:text/html,${encodeURIComponent(`
        <!doctype html>
        <title>Clero Managed Browser Smoke</title>
        <input id="q" aria-label="Query" />
        <button id="go" onclick="document.body.dataset.clicked = 'yes'; document.querySelector('#result').textContent = document.querySelector('#q').value">Go</button>
        <div id="result"></div>
      `)}`
    });
    const snapshot = await adapter.getSnapshot({});
    await adapter.type({ selector: "#q", text: "hello from clero" });
    await adapter.click({ selector: "#go" });
    const content = await adapter.getPageContent({});
    const tabs = await adapter.listTabs({});
    console.log("browser.list_tabs ok");
    console.log(JSON.stringify({
      page_count: Array.isArray(tabs.pages) ? tabs.pages.length : 0,
      snapshot_title: snapshot.title,
      interactive_elements: Array.isArray(snapshot.elements) ? snapshot.elements.length : 0,
      content_has_typed_text: typeof content.content === "string" && content.content.includes("hello from clero")
    }, null, 2));
  } finally {
    await adapter.dispose();
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`managed browser smoke test failed: ${message}`);
  process.exitCode = 1;
});
