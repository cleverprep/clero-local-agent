import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { JsonObject } from "@clero-local-agent/protocol";

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

export function createDefaultApprovalProvider(interactive: boolean): ApprovalProvider {
  return interactive ? new TerminalApprovalProvider() : new StaticApprovalProvider(false, "Interactive approval is disabled");
}
