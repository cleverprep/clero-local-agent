export type AgentSession = {
  agentId: string;
  connectedAtMs: number;
  lastSeenAtMs: number;
};

export type RegisterAgentResult =
  | { status: "registered"; session: AgentSession }
  | { status: "already_registered"; session: AgentSession }
  | { status: "slot_limit"; maxAgentSlots: number };

export class AgentSessionRegistry {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly maxAgentSlots: number;
  private readonly now: () => number;

  constructor(maxAgentSlots: number, now: () => number = Date.now) {
    this.maxAgentSlots = maxAgentSlots;
    this.now = now;
  }

  register(agentId: string): RegisterAgentResult {
    const existing = this.sessions.get(agentId);
    if (existing) {
      existing.lastSeenAtMs = this.now();
      return { status: "already_registered", session: existing };
    }

    if (this.sessions.size >= this.maxAgentSlots) {
      return { status: "slot_limit", maxAgentSlots: this.maxAgentSlots };
    }

    const session = {
      agentId,
      connectedAtMs: this.now(),
      lastSeenAtMs: this.now()
    };
    this.sessions.set(agentId, session);
    return { status: "registered", session };
  }

  touch(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    if (!session) {
      return false;
    }

    session.lastSeenAtMs = this.now();
    return true;
  }

  unregister(agentId: string): void {
    this.sessions.delete(agentId);
  }

  clear(): void {
    this.sessions.clear();
  }

  size(): number {
    return this.sessions.size;
  }

  list(): AgentSession[] {
    return [...this.sessions.values()];
  }
}
