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

export class ConsoleAuditLogger implements AuditLogger {
  record(event: AuditEvent): void {
    console.log(JSON.stringify({ audit: event }));
  }
}
