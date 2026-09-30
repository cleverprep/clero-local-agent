import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultExtractSchema } from "@browserbasehq/stagehand";
import { CleroStagehandLLMClient, stagehandRelayUrl, runLocalStagehand } from "../src/stagehand.ts";
import { BrowserTools, ManagedBrowserAdapter } from "../src/index.ts";

const options = { messages: [{ role: "user" as const, content: "Read the page" }], response_model: { name: "extraction", schema: defaultExtractSchema } };

test("relay uses paired backend origin and removes websocket tokens", () => {
  assert.equal(stagehandRelayUrl("wss://api.example.com/ws/local-runtime/?token=private"), "https://api.example.com/api/v1/integrations/local-runtime/stagehand/");
});

test("SDK model call relays native schema and parses result without provider credentials", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://clero.example/relay/");
    assert.equal((init?.headers as Record<string,string>).Authorization, "Bearer invocation-token");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.messages, options.messages);
    assert.equal(body.schema.type, "object");
    assert.ok(!("apiKey" in body));
    return new Response(JSON.stringify({ data: { extraction: "Example Domain" }, usage: { total_tokens: 5 } }), { status: 200 });
  };
  try {
    const client = new CleroStagehandLLMClient("https://clero.example/relay/", "invocation-token");
    const result = await client.createChatCompletion({ options, logger: () => {} });
    assert.deepEqual(result, { data: { extraction: "Example Domain" }, usage: { total_tokens: 5 } });
  } finally { globalThis.fetch = original; }
});

test("relay failure does not forward private provider text", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("private provider details", { status: 403 });
  try {
    const client = new CleroStagehandLLMClient("https://clero.example/relay/", "invocation-token");
    await assert.rejects(client.createChatCompletion({ options, logger: () => {} }), error => error instanceof Error && !error.message.includes("private provider details") && error.message.includes("403"));
  } finally { globalThis.fetch = original; }
});

test("unauthorized Stagehand never starts a browser", async () => {
  await assert.rejects(runLocalStagehand({ endpoint: "http://127.0.0.1:9222", page: null, action: "act", instruction: "Click Search" }), /authorize/);
});

test("managed browser advertises native instruction tools", () => {
  const definitions = new BrowserTools(new ManagedBrowserAdapter()).definitions();
  for (const name of ["browser.act", "browser.observe", "browser.extract"]) assert.ok(definitions.some(item => item.name === name));
});
