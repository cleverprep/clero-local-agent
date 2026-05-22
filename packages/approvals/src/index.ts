import readline from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { stdin as input, stdout as output } from "node:process";

export const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ApprovalRequestMessage = {
  type: "approval_request";
  request_id: string;
  tool: string;
  summary: string;
  metadata?: JsonObject;
};

export type ApprovalResponseMessage = {
  type: "approval_response";
  request_id: string;
  approved: boolean;
  reason?: string;
};

export type ApprovalRequest = {
  tool: string;
  summary: string;
  metadata?: JsonObject;
};

export type ApprovalDecision = {
  approved: boolean;
  reason?: string;
};

export interface ApprovalProvider {
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export type SendApprovalRequest = (request: ApprovalRequestMessage) => Promise<ApprovalResponseMessage>;

export class StaticApprovalProvider implements ApprovalProvider {
  private readonly approved: boolean;
  private readonly reason: string;

  constructor(approved: boolean, reason = "Static approval policy") {
    this.approved = approved;
    this.reason = reason;
  }

  async requestApproval(): Promise<ApprovalDecision> {
    return {
      approved: this.approved,
      reason: this.reason
    };
  }
}

export class TerminalApprovalProvider implements ApprovalProvider {
  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const rl = readline.createInterface({ input, output });
    try {
      console.log(`Approval required for ${request.tool}`);
      console.log(request.summary);
      const answer = await rl.question("Approve? [y/N] ");
      const approved = answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
      return {
        approved,
        reason: approved ? "Approved locally" : "Denied locally"
      };
    } finally {
      rl.close();
    }
  }
}

export class WebSocketApprovalProvider implements ApprovalProvider {
  private readonly sendApprovalRequest: SendApprovalRequest;
  private readonly timeoutMs: number;

  constructor(sendApprovalRequest: SendApprovalRequest, timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS) {
    this.sendApprovalRequest = sendApprovalRequest;
    this.timeoutMs = timeoutMs;
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const requestId = randomUUID();
    const message: ApprovalRequestMessage = {
      type: "approval_request",
      request_id: requestId,
      tool: request.tool,
      summary: request.summary,
      metadata: request.metadata
    };

    try {
      const response = await this.waitForResponse(this.sendApprovalRequest(message), requestId);
      if (response.request_id !== requestId) {
        return {
          approved: false,
          reason: "Approval response request_id mismatch"
        };
      }
      return {
        approved: response.approved,
        reason: response.reason
      };
    } catch (error: unknown) {
      return {
        approved: false,
        reason: `Approval request failed: ${errorMessage(error)}`
      };
    }
  }

  private waitForResponse(
    response: Promise<ApprovalResponseMessage>,
    requestId: string
  ): Promise<ApprovalResponseMessage> {
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        resolve({
          type: "approval_response",
          request_id: requestId,
          approved: false,
          reason: "Approval timed out"
        });
      }, this.timeoutMs);

      response.then(
        (message) => {
          if (timedOut) {
            return;
          }
          clearTimeout(timeout);
          resolve(message);
        },
        (error: unknown) => {
          if (timedOut) {
            return;
          }
          clearTimeout(timeout);
          reject(error);
        }
      );
    });
  }
}

export function createDefaultApprovalProvider(interactive: boolean): ApprovalProvider {
  return interactive ? new TerminalApprovalProvider() : new StaticApprovalProvider(false, "Interactive approval is disabled");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
