import assert from "node:assert/strict";
import test from "node:test";
import { PairingClient } from "../src/pairing-client.ts";

test("claims a local runtime pairing code against the backend claim endpoint", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json({
      connection_id: 45,
      device_token: "clrt_test",
      websocket_url: "ws://localhost:8000/ws/local-runtime/"
    });
  };

  try {
    const client = new PairingClient({
      backendUrl: "http://localhost:8000/api/v1/integrations/local-runtime/pairing-codes/",
      daemonVersion: "0.1.6"
    });
    const result = await client.pair({
      code: "LRA-FFBD-4222-7DA1",
      deviceName: "Local Mac",
      capabilities: { tools: [] }
    });

    assert.deepEqual(result, {
      connection_id: 45,
      device_token: "clrt_test",
      websocket_url: "ws://localhost:8000/ws/local-runtime/"
    });
    assert.equal(calls[0]?.url, "http://localhost:8000/api/v1/integrations/local-runtime/claim/");
    assert.equal(calls[0]?.init.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      pairing_code: "LRA-FFBD-4222-7DA1",
      device_name: "Local Mac",
      platform: process.platform,
      daemon_version: "0.1.6",
      capabilities: { tools: [] }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
