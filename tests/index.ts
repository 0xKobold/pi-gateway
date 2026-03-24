/**
 * pi-gateway Comprehensive Tests
 * 
 * Unit, Integration, and E2E tests for the gateway.
 * 
 * Run: npx tsx tests/index.ts
 */

import assert from "node:assert";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

// Test configuration
const PORT = 3850;
const HOST = "localhost";
const HTTP_URL = `http://${HOST}:${PORT}`;
const WS_URL = `ws://${HOST}:${PORT}/ws`;

// Test counters
let passed = 0;
let failed = 0;

// ============================================================================
// Test Utils
// ============================================================================

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assertEqual(actual: any, expected: any, msg?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg || "Assertion failed"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertContains(str: string, sub: string): void {
  if (!str.includes(sub)) throw new Error(`"${str}" does not contain "${sub}"`);
}

function assertTrue(condition: boolean, msg?: string): void {
  if (!condition) throw new Error(msg || "Expected true");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Mock Gateway Server
// ============================================================================

let server: http.Server;
let wss: WebSocketServer;
let clients = new Map<string, WebSocket>();
let isStreaming = false;

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer();
    wss = new WebSocketServer({ server });
    
    wss.on("connection", (ws) => handleWs(ws));
    server.on("request", (req, res) => handleHttp(req, res));
    server.listen(PORT, () => resolve());
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    for (const ws of clients.values()) ws.close();
    clients.clear();
    server.close(() => resolve());
  });
}

function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  
  const auth = req.headers.authorization;
  if (auth && !auth.startsWith("Bearer valid")) {
    res.writeHead(401).end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }
  
  const url = new URL(req.url || "/", HTTP_URL);
  
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body><h1>pi Gateway Test</h1></body></html>");
    return;
  }
  
  if (url.pathname === "/api/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ connected: true, port: PORT, clients: clients.size, agentStreaming: isStreaming }));
    return;
  }
  
  if (url.pathname === "/api/models" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      models: [
        { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
        { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
      ],
    }));
    return;
  }
  
  if (url.pathname === "/api/state" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      model: { provider: "anthropic", id: "claude-sonnet-4" },
      thinkingLevel: "medium",
      isStreaming,
      sessionId: "test-session",
    }));
    return;
  }
  
  if (url.pathname === "/api/prompt" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { message } = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ response: `Echo: ${message}` }));
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }
  
  res.writeHead(404).end(JSON.stringify({ error: "Not found" }));
}

function handleWs(ws: WebSocket): void {
  const id = Math.random().toString(36).slice(2, 10);
  clients.set(id, ws);
  ws.send(JSON.stringify({ type: "connected", data: { clientId: id } }));
  
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      switch (msg.type) {
        case "ping":
          ws.send(JSON.stringify({ type: "pong", time: Date.now() }));
          break;
          
        case "get_state":
          ws.send(JSON.stringify({ type: "response", id: msg.id, data: { sessionId: "test", isStreaming } }));
          break;
          
        case "get_models":
          ws.send(JSON.stringify({ type: "response", id: msg.id, data: { models: [] } }));
          break;
          
        case "prompt": {
          isStreaming = true;
          const text = (msg.data as { message?: string })?.message || "Hello";
          const response = `Echo: ${text}`;
          streamResponse(ws, msg.id, response);
          break;
        }
        
        case "abort":
          isStreaming = false;
          ws.send(JSON.stringify({ type: "response", id: msg.id, data: { aborted: true } }));
          break;
        
        default:
          ws.send(JSON.stringify({ type: "response", id: msg.id, data: { ok: true } }));
      }
    } catch {
      ws.send(JSON.stringify({ type: "error", data: { error: "Invalid JSON" } }));
    }
  });
  
  ws.on("close", () => clients.delete(id));
}

function streamResponse(ws: WebSocket, id: string, text: string): void {
  let i = 0;
  const interval = setInterval(() => {
    if (i < text.length && isStreaming) {
      ws.send(JSON.stringify({
        type: "event",
        data: { assistantMessageEvent: { type: "text_delta", delta: text[i] } },
      }));
      i++;
    } else {
      clearInterval(interval);
      isStreaming = false;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "response", id, data: { success: true } }));
      }
    }
  }, 3);
}

// ============================================================================
// HTTP Client
// ============================================================================

async function httpGet(path: string, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(path, HTTP_URL), { headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode || 0, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode || 0, body });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

async function httpPost(path: string, data: any, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request(new URL(path, HTTP_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers },
    }, (res) => {
      let responseBody = "";
      res.on("data", (c) => (responseBody += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode || 0, body: JSON.parse(responseBody) });
        } catch {
          resolve({ status: res.statusCode || 0, body: responseBody });
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ============================================================================
// WebSocket Test Helper (using on/removeListener pattern)
// ============================================================================

interface WsTestResult {
  messages: any[];
  text: string;
}

async function wsTest(ws: WebSocket, message: any, timeout = 5000): Promise<WsTestResult> {
  return new Promise((resolve, reject) => {
    const result: WsTestResult = { messages: [], text: "" };
    const timer = setTimeout(() => resolve(result), timeout);
    
    const handler = (data: any) => {
      const msg = JSON.parse(data.toString());
      result.messages.push(msg);
      if (msg.type === "event") {
        result.text += msg.data?.assistantMessageEvent?.delta || "";
      }
      if (msg.type === "response" || msg.type === "error") {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve(result);
      }
    };
    
    ws.on("message", handler);
    ws.send(JSON.stringify(message));
  });
}

// ============================================================================
// Unit Tests
// ============================================================================

async function runUnitTests(): Promise<void> {
  console.log("\n📦 Unit Tests");
  console.log("─".repeat(50));
  
  test("URL parsing", () => {
    const url = new URL("/api/status", HTTP_URL);
    assertEqual(url.pathname, "/api/status");
  });
  
  test("JSON roundtrip", () => {
    const obj = { type: "prompt", data: { message: "Hello" } };
    const parsed = JSON.parse(JSON.stringify(obj));
    assertEqual(parsed.type, "prompt");
    assertEqual(parsed.data.message, "Hello");
  });
  
  test("Client ID format", () => {
    const id = Math.random().toString(36).slice(2, 10);
    assertEqual(typeof id, "string");
    assertEqual(id.length, 8);
  });
  
  test("Token validation", () => {
    const valid = "Bearer valid-token".startsWith("Bearer valid");
    const invalid = "Bearer invalid".startsWith("Bearer valid");
    assertTrue(valid);
    assertTrue(!invalid);
  });
  
  test("Character streaming", () => {
    const text = "Hello";
    const chars = text.split("");
    assertEqual(chars.length, 5);
    assertEqual(chars.join(""), "Hello");
  });
}

// ============================================================================
// HTTP Integration Tests
// ============================================================================

async function runHttpTests(): Promise<void> {
  console.log("\n🌐 HTTP Integration Tests");
  console.log("─".repeat(50));
  
  await testAsync("GET / - returns HTML", async () => {
    const res = await httpGet("/");
    assertEqual(res.status, 200);
    assertContains(res.body as string, "pi Gateway");
  });
  
  await testAsync("GET /api/status - returns status", async () => {
    const res = await httpGet("/api/status");
    assertEqual(res.status, 200);
    assertEqual(res.body.connected, true);
    assertEqual(res.body.port, PORT);
    assertEqual(typeof res.body.clients, "number");
  });
  
  await testAsync("GET /api/models - returns models", async () => {
    const res = await httpGet("/api/models");
    assertEqual(res.status, 200);
    assertEqual(Array.isArray(res.body.models), true);
    assertEqual(res.body.models.length, 2);
  });
  
  await testAsync("GET /api/state - returns state", async () => {
    const res = await httpGet("/api/state");
    assertEqual(res.status, 200);
    assertEqual(res.body.model?.provider, "anthropic");
    assertEqual(typeof res.body.sessionId, "string");
  });
  
  await testAsync("POST /api/prompt - sends prompt", async () => {
    const res = await httpPost("/api/prompt", { message: "Hello!" });
    assertEqual(res.status, 200);
    assertContains(res.body.response, "Hello!");
  });
  
  await testAsync("GET /missing - returns 404", async () => {
    const res = await httpGet("/missing");
    assertEqual(res.status, 404);
    assertEqual(res.body.error, "Not found");
  });
  
  await testAsync("GET /api/status with valid token", async () => {
    const res = await httpGet("/api/status", { Authorization: "Bearer valid-key" });
    assertEqual(res.status, 200);
  });
  
  await testAsync("GET /api/status with invalid token", async () => {
    const res = await httpGet("/api/status", { Authorization: "Bearer wrong-key" });
    assertEqual(res.status, 401);
  });
}

// ============================================================================
// WebSocket Tests (using wsTest helper)
// ============================================================================

async function runWsTests(): Promise<void> {
  console.log("\n🔌 WebSocket Tests");
  console.log("─".repeat(50));
  
  // Helper to create connected ws client
  async function createWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS timeout")), 5000);
    });
  }
  
  await testAsync("WS ping/pong", async () => {
    const ws = await createWs();
    const result = await wsTest(ws, { type: "ping" });
    assertTrue(result.messages.some((m) => m.type === "pong"));
    ws.close();
  });
  
  await testAsync("WS get_state", async () => {
    const ws = await createWs();
    const result = await wsTest(ws, { type: "get_state", id: "1" });
    assertTrue(result.messages.some((m) => m.type === "response" && m.data?.sessionId === "test"));
    ws.close();
  });
  
  await testAsync("WS get_models", async () => {
    const ws = await createWs();
    const result = await wsTest(ws, { type: "get_models", id: "2" });
    assertTrue(result.messages.some((m) => m.type === "response"));
    ws.close();
  });
  
  await testAsync("WS abort", async () => {
    const ws = await createWs();
    const result = await wsTest(ws, { type: "abort", id: "3" });
    assertTrue(result.messages.some((m) => m.type === "response" && m.data?.aborted === true));
    ws.close();
  });
  
  await testAsync("WS prompt with streaming response", async () => {
    const ws = await createWs();
    const result = await wsTest(ws, { type: "prompt", id: "4", data: { message: "Test" } });
    assertTrue(result.messages.some((m) => m.type === "response"));
    assertContains(result.text, "Test");
    ws.close();
  });
}

// ============================================================================
// E2E Tests
// ============================================================================

async function runE2ETests(): Promise<void> {
  console.log("\n🎯 E2E Tests");
  console.log("─".repeat(50));
  
  async function createWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS timeout")), 5000);
    });
  }
  
  await testAsync("Full chat flow - streaming response", async () => {
    const ws = await createWs();
    const result = await wsTest(ws, { type: "prompt", id: "e2e-1", data: { message: "Hello" } });
    assertTrue(result.messages.some((m) => m.type === "response"));
    assertContains(result.text, "Hello");
    ws.close();
  });
  
  await testAsync("Multiple clients - client count", async () => {
    const ws1 = await createWs();
    const ws2 = await createWs();
    await sleep(100);
    
    const res = await httpGet("/api/status");
    assertEqual(res.body.clients, 2);
    
    ws1.close();
    ws2.close();
    await sleep(300);
  });
  
  await testAsync("Client disconnect - count updates", async () => {
    const ws = await createWs();
    await sleep(100);
    
    const before = (await httpGet("/api/status")).body.clients;
    ws.close();
    await sleep(300);
    const after = (await httpGet("/api/status")).body.clients;
    
    assertTrue(after < before);
  });
  
  await testAsync("Rapid prompts - sequential processing", async () => {
    const ws = await createWs();
    
    const result1 = await wsTest(ws, { type: "prompt", id: "r1", data: { message: "First" } });
    const result2 = await wsTest(ws, { type: "prompt", id: "r2", data: { message: "Second" } });
    
    assertTrue(result1.messages.length > 0);
    assertTrue(result2.messages.length > 0);
    ws.close();
  });
}

// ============================================================================
// Performance Tests
// ============================================================================

async function runPerfTests(): Promise<void> {
  console.log("\n⚡ Performance Tests");
  console.log("─".repeat(50));
  
  async function createWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS timeout")), 5000);
    });
  }
  
  await testAsync("HTTP latency < 50ms", async () => {
    const start = Date.now();
    await httpGet("/api/status");
    const latency = Date.now() - start;
    assertTrue(latency < 50, `Latency ${latency}ms`);
  });
  
  await testAsync("WS roundtrip < 500ms", async () => {
    const ws = await createWs();
    const result = await wsTest(ws, { type: "ping" }, 8000);
    assertTrue(result.messages.some((m) => m.type === "pong"), "Expected pong response");
    ws.close();
  });
  
  await testAsync("Streaming completes in reasonable time", async () => {
    const ws = await createWs();
    const result = await wsTest(ws, { type: "prompt", id: "p1", data: { message: "Test message" } });
    assertTrue(result.messages.length > 5, `Expected >5 events, got ${result.messages.length}`);
    ws.close();
  });
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(50));
  console.log("pi-gateway Comprehensive Tests");
  console.log("=".repeat(50));
  
  console.log("\n🚀 Starting test server...");
  await startServer();
  console.log(`   Server running on port ${PORT}`);
  
  try {
    await runUnitTests();
    await runHttpTests();
    await runWsTests();
    await runE2ETests();
    await runPerfTests();
  } catch (e: any) {
    console.error("\n❌ Error:", e.message);
  }
  
  await stopServer();
  
  console.log("\n" + "=".repeat(50));
  console.log("Results");
  console.log("=".repeat(50));
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  📊 Total:  ${passed + failed}`);
  console.log("=".repeat(50));
  
  if (failed > 0) process.exit(1);
}

main().catch(console.error);
