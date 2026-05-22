import type { JsonObject, JsonValue } from "@clero-local-agent/protocol";

export type AuditEvent = {
  at: string;
  event: string;
  requestId?: string;
  agentId?: string;
  taskId?: string;
  eventRunId?: string;
  requestedActionKey?: string;
  leaseId?: string;
  tool?: string;
  metadata?: JsonObject;
  result?: JsonValue;
};

export interface AuditLogger {
  record(event: AuditEvent): void;
}

const SENSITIVE_FIELDS = new Set(["data_base64", "base64", "screenshot_data"]);
const MAX_SENSITIVE_FIELD_LEN = 100;

function redactSensitive(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item) ?? null);
  if (typeof value === "object") {
    const out: JsonObject = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_FIELDS.has(key) && typeof val === "string" && val.length > MAX_SENSITIVE_FIELD_LEN) {
        out[key] = `${val.slice(0, MAX_SENSITIVE_FIELD_LEN)}...[truncated ${val.length} chars]`;
      } else {
        out[key] = redactSensitive(val) as JsonValue;
      }
    }
    return out;
  }
  return value;
}

export class ConsoleAuditLogger implements AuditLogger {
  record(event: AuditEvent): void {
    const redacted: AuditEvent = {
      ...event,
      metadata: redactSensitive(event.metadata) as JsonObject | undefined,
      result: redactSensitive(event.result),
    };
    console.log(JSON.stringify({ audit: redacted }));
  }
}
