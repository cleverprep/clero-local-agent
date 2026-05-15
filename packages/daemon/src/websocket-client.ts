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
    this.socket?.close();
    this.socket = null;
  }

  send(message: RuntimeMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }

    this.socket.send(JSON.stringify(message));
  }

  private connect(): void {
    const url = new URL(this.options.url);
    url.searchParams.set("token", this.options.token);
    this.socket = new WebSocket(url.toString());

    this.socket.addEventListener("open", () => {
      this.options.logger.info("local runtime websocket connected");
      this.emit("open");
    });

    this.socket.addEventListener("message", (event: { data: string }) => {
      try {
        const message: unknown = JSON.parse(event.data);
        this.options.logger.info("received websocket message", { inbound: message });
        this.emit("message", message);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger.warn("failed to parse websocket message", { error: message });
      }
    });

    this.socket.addEventListener("close", () => {
      this.options.logger.warn("local runtime websocket closed");
      this.emit("close");
      if (this.shouldReconnect) {
        setTimeout(() => this.connect(), this.reconnectDelayMs);
      }
    });

    this.socket.addEventListener("error", (event: unknown) => {
      this.options.logger.error("local runtime websocket error", { event: String(event) });
    });
  }
}
