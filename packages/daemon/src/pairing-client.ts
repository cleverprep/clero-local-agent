import os from "node:os";
import type { JsonObject } from "@clero-local-agent/protocol";

export type PairingClientOptions = {
  backendUrl: string;
  claimPath?: string;
  daemonVersion?: string;
};

export type PairDeviceInput = {
  code: string;
  deviceName?: string;
  capabilities?: JsonObject;
};

export type PairDeviceResult = {
  connection_id: number;
  device_token: string;
  websocket_url: string;
  expires_at?: string;
};

export class PairingClient {
  private readonly backendUrl: string;
  private readonly claimPath: string;
  private readonly daemonVersion: string;

  constructor(options: PairingClientOptions) {
    this.backendUrl = normalizeBackendOrigin(options.backendUrl);
    this.claimPath = options.claimPath ?? "/api/v1/integrations/local-runtime/claim/";
    this.daemonVersion = options.daemonVersion ?? "0.1.2";
  }

  async pair(input: PairDeviceInput): Promise<PairDeviceResult> {
    const response = await fetch(`${this.backendUrl}${this.claimPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        pairing_code: input.code,
        device_name: input.deviceName ?? os.hostname(),
        platform: process.platform,
        daemon_version: this.daemonVersion,
        capabilities: input.capabilities ?? { tools: [] }
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Pairing failed with HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }

    const json = (await response.json()) as Partial<PairDeviceResult>;
    if (typeof json.connection_id !== "number" || !json.device_token || !json.websocket_url) {
      throw new Error("Pairing response did not include connection_id, device_token, and websocket_url");
    }

    const result: PairDeviceResult = {
      connection_id: json.connection_id,
      device_token: json.device_token,
      websocket_url: json.websocket_url
    };
    if (json.expires_at) {
      result.expires_at = json.expires_at;
    }

    return result;
  }
}

export function createPairingClient(options: PairingClientOptions): PairingClient {
  return new PairingClient(options);
}

function normalizeBackendOrigin(value: string): string {
  const url = new URL(value);
  return url.origin;
}
