import { EventEmitter } from "node:events";
import type { RuntimeMessage } from "@clero-local-agent/protocol";
import type { Logger } from "./logger.ts";

type RuntimeWebSocket = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: any) => void): void;
};

type WebSocketConstructor = new (url: string, protocols?: string | string[]) => RuntimeWebSocket;

declare const WebSocket: WebSocketConstructor & { OPEN: number };

export type RuntimeWebSocketClientOptions = {
  url: string;
  token: string;
  reconnectDelayMs?: number;
  logger: Logger;
};

export class RuntimeWebSocketClient extends EventEmitter {
  private socket: RuntimeWebSocket | null = null;
  private authenticated = false;
  private shouldReconnect = true;
  private readonly reconnectDelayMs: number;
  private readonly options: RuntimeWebSocketClientOptions;

  constructor(options: RuntimeWebSocketClientOptions) {
    super();
    this.options = options;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
  }

  async start(): Promise<void> {
    this.shouldReconnect = true;
    this.connect();
  }

  async stop(): Promise<void> {
    this.shouldReconnect = false;
    this.authenticated = false;
    this.socket?.close();
    this.socket = null;
  }

  reconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    socket?.close();
    this.emit("close");
    if (this.shouldReconnect) {
      setTimeout(() => this.connect(), this.reconnectDelayMs);
    }
  }

  send(message: RuntimeMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.authenticated) {
      throw new Error("WebSocket is not connected");
    }

    this.socket.send(JSON.stringify(message));
  }

  private connect(): void {
    const url = new URL(this.options.url);
    url.searchParams.set("token", this.options.token);
    const socket = new WebSocket(url.toString());
    this.socket = socket;
    this.authenticated = false;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "auth", token: this.options.token }));
      this.options.logger.info("local runtime websocket connected; auth message sent");
    });

    socket.addEventListener("message", (event: { data: string }) => {
      try {
        const message: unknown = JSON.parse(event.data);
        this.options.logger.info("received websocket message", { inbound: message });
        if (!this.authenticated && isAuthAcknowledgementMessage(message)) {
          this.authenticated = true;
          this.options.logger.info("local runtime websocket authenticated");
          this.emit("open");
        }
        this.emit("message", message);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger.warn("failed to parse websocket message", { error: message });
      }
    });

    socket.addEventListener("close", (event: { code?: number; reason?: string; wasClean?: boolean }) => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.authenticated = false;
      this.options.logger.warn("local runtime websocket closed", {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean
      });
      this.emit("close");
      if (this.shouldReconnect) {
        setTimeout(() => this.connect(), this.reconnectDelayMs);
      }
    });

    socket.addEventListener("error", (event: unknown) => {
      this.options.logger.error("local runtime websocket error", { event: websocketEventDetail(event) });
    });
  }
}

function isAuthAcknowledgementMessage(value: unknown): value is { type: string } {
  return isRecord(value) && (value.type === "auth_ack" || value.type === "authenticated" || value.type === "connected");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function websocketEventDetail(event: unknown): string {
  if (!isRecord(event)) {
    return String(event);
  }

  const detail = [event.message, event.error, event.reason, event.type]
    .map((value) => {
      if (typeof value === "string") return value;
      if (value instanceof Error) return value.message;
      return "";
    })
    .find((value) => value.trim().length > 0);
  return detail ?? "WebSocket error";
}
