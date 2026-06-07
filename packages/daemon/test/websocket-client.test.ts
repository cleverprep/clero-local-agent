import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { RuntimeMessage } from "@clero-local-agent/protocol";
import { RuntimeWebSocketClient } from "../src/websocket-client.ts";

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

type Listener = (event: any) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly listeners = new Map<string, Listener[]>();
  readonly sent: string[] = [];
  readonly url: string;
  readyState = FakeWebSocket.OPEN;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: any = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

test("uses URL token authentication without sending a legacy auth message", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  const client = new RuntimeWebSocketClient({
    url: "wss://clero.so/ws/local-runtime/",
    token: "clrt_test",
    logger
  });

  await client.start();
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  assert.equal(socket.url, "wss://clero.so/ws/local-runtime/?token=clrt_test");

  socket.emit("open");
  assert.deepEqual(socket.sent, []);

  let opened = false;
  client.on("open", () => {
    opened = true;
  });
  socket.emit("message", { data: JSON.stringify({ type: "connected", connection_id: 1 }) });
  assert.equal(opened, true);

  const heartbeat = { type: "heartbeat", capabilities: { tools: [] } } as RuntimeMessage;
  client.send(heartbeat);
  assert.deepEqual(socket.sent, [JSON.stringify(heartbeat)]);

  await client.stop();
});

test("reconnects when the active websocket errors without a close event", async (t) => {
  const originalWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  const client = new RuntimeWebSocketClient({
    url: "wss://clero.so/ws/local-runtime/",
    token: "clrt_test",
    reconnectDelayMs: 1,
    logger
  });

  let closeEvents = 0;
  client.on("close", () => {
    closeEvents += 1;
  });

  await client.start();
  const firstSocket = FakeWebSocket.instances[0];
  assert.ok(firstSocket);

  firstSocket.emit("error", { message: "Received network error or non-101 status code." });
  await delay(10);

  assert.equal(closeEvents, 1);
  assert.equal(firstSocket.readyState, 3);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(FakeWebSocket.instances[1]?.url, "wss://clero.so/ws/local-runtime/?token=clrt_test");

  await client.stop();
});
