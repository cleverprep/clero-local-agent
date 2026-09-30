import { LLMClient, Stagehand, toJsonSchema, type CreateChatCompletionOptions, type LLMResponse } from "@browserbasehq/stagehand";
import { ToolExecutionError, type ToolExecutionContext } from "@clero-local-agent/mcp-runtime";
import type { JsonObject } from "@clero-local-agent/protocol";

// The backend controls inference through LOCAL_STAGEHAND_MODEL; no provider key is stored locally.
const STAGEHAND_MODEL = "google/gemini-3.5-flash-lite";

export class CleroStagehandLLMClient extends LLMClient {
  private readonly relayUrl: string;
  private readonly token: string;

  constructor(relayUrl: string, token: string) {
    super(STAGEHAND_MODEL);
    this.relayUrl = relayUrl;
    this.token = token;
    this.type = "clero";
    this.hasVision = false;
  }

  async createChatCompletion<T = LLMResponse>({ options }: CreateChatCompletionOptions): Promise<T> {
    if (!options.response_model || options.image || options.tools?.length) {
      throw new ToolExecutionError("tool_failed", "Local Stagehand supports structured DOM operations only.");
    }
    const response = await fetch(this.relayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ messages: options.messages, schema: toJsonSchema(options.response_model.schema) }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) {
      throw new ToolExecutionError("tool_failed", `Clero browser model request failed (${response.status}). Inspect the page before retrying.`);
    }
    const result = await response.json();
    return { data: options.response_model.schema.parse(result.data), usage: result.usage } as T;
  }
}

export function stagehandRelayUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/api/v1/integrations/local-runtime/stagehand/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function runLocalStagehand(input: {
  endpoint: string; page: any; action: string; instruction: string;
  context?: ToolExecutionContext;
}): Promise<JsonObject> {
  if (!input.context?.stagehandToken || !input.context.stagehandRelayUrl) {
    throw new ToolExecutionError("tool_failed", "Clero did not authorize model access for this browser action. Reconnect to the updated backend.");
  }
  const discovery = await fetch(`${input.endpoint}/json/version`, { signal: AbortSignal.timeout(5_000) });
  if (!discovery.ok) throw new ToolExecutionError("tool_failed", "Local browser debugging endpoint is unavailable.");
  const version = await discovery.json();
  const cdpUrl = new URL(version.webSocketDebuggerUrl);
  const expected = new URL(input.endpoint);
  if (cdpUrl.protocol !== "ws:" || cdpUrl.hostname !== expected.hostname || cdpUrl.port !== expected.port) {
    throw new ToolExecutionError("tool_failed", "Invalid local browser debugging endpoint.");
  }
  const stagehand = new Stagehand({
    env: "LOCAL", keepAlive: true, model: STAGEHAND_MODEL,
    localBrowserLaunchOptions: { cdpUrl: cdpUrl.toString() },
    llmClient: new CleroStagehandLLMClient(input.context.stagehandRelayUrl, input.context.stagehandToken),
    verbose: 0, disablePino: true, logger: () => {}, logInferenceToFile: false
  });
  try {
    await stagehand.init();
    const options = { page: input.page };
    if (input.action === "observe") return { actions: await stagehand.observe(input.instruction, options) } as unknown as JsonObject;
    if (input.action === "act") return await stagehand.act(input.instruction, options) as unknown as JsonObject;
    return await stagehand.extract(input.instruction || "Extract the relevant page content", options) as unknown as JsonObject;
  } finally {
    await stagehand.close().catch(() => null);
  }
}
