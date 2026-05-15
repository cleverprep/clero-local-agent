import process from "node:process";
import { McpChromeBrowserAdapter } from "../packages/browser/src/index.ts";

const endpointUrl = process.env.CLERO_BROWSER_MCP_URL ?? "http://127.0.0.1:12306/mcp";

async function main(): Promise<void> {
  const adapter = new McpChromeBrowserAdapter({ endpointUrl });

  console.log(`Checking mcp-chrome endpoint: ${endpointUrl}`);
  const tools = await adapter.listTools();
  console.log("tools/list ok");
  console.log(JSON.stringify(tools, null, 2).slice(0, 2_000));

  const tabs = await adapter.listTabs({});
  console.log("browser.list_tabs ok");
  console.log(JSON.stringify(tabs, null, 2).slice(0, 4_000));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`mcp-chrome smoke test failed: ${message}`);
  process.exitCode = 1;
});
