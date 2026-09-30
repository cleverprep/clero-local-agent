import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { ManagedBrowserAdapter } from "../packages/browser/src/index.ts";

const grantPath = process.argv[2];
if (!grantPath) throw new Error("Provide a private JSON file containing a backend-issued test token.");
const { token, relayUrl } = JSON.parse(await readFile(grantPath, "utf8"));
const fixture = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><html><head><title>Clero local Stagehand test</title></head><body><h1>Local browser test</h1><button onclick="document.getElementById('result').textContent='Stagehand local browser works'">Show result</button><h2>Result</h2><p id="result">Waiting</p></body></html>`);
});
await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address();
if (!address || typeof address === "string") throw new Error("No fixture server address");
const adapter = new ManagedBrowserAdapter({ rememberSession: false, headless: true, browserChannel: "chrome" });
const context = { requestId: "isolated-stagehand-test", stagehandToken: token, stagehandRelayUrl: relayUrl ?? "http://127.0.0.1:8001/api/v1/integrations/local-runtime/stagehand/" };
try {
  await adapter.openUrl({ url: `http://127.0.0.1:${address.port}` });
  const observed = await adapter.stagehand({ action: "observe", instruction: "Find the Show result button" }, context);
  assert.ok(Array.isArray(observed.actions) && observed.actions.length > 0);
  console.log("Stagehand observe: found the test button");
  const acted = await adapter.stagehand({ action: "act", instruction: "Click the Show result button" }, context);
  assert.equal(acted.success, true);
  console.log("Stagehand act: clicked the test button");
  const extracted = await adapter.stagehand({ action: "extract", instruction: "Read the text directly under the Result heading" }, context);
  assert.match(JSON.stringify(extracted), /Stagehand local browser works/);
  console.log("Stagehand extract: verified the changed page text");
} finally {
  await adapter.dispose();
  fixture.close();
}
