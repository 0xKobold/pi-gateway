/**
 * pi-gateway Extension
 * 
 * HTTP/WebSocket gateway that exposes the pi agent to external clients.
 * Allows web, mobile, and other applications to chat with your pi agent.
 * 
 * Usage:
 *   /gateway start [port]    - Start the gateway server
 *   /gateway stop            - Stop the gateway server
 *   /gateway status          - Show gateway status
 *   /gateway token          - Generate/manage access tokens
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const CONFIG_DIR = join(homedir(), ".pi", "gateway");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const SESSIONS_DIR = join(CONFIG_DIR, "sessions");

interface GatewayConfig {
  port: number;
  host: string;
  tokens: string[];
  corsOrigins: string[];
  enableWebSocket: boolean;
  enableHttp: boolean;
}

interface ClientSession {
  id: string;
  ws?: WebSocket;
  lastActivity: number;
  sessionFile?: string;
}

interface WsMessage {
  type: string;
  id?: string;
  data?: unknown;
}

// Shared context for status updates
let globalCtx: ExtensionContext | null = null;

// Helper to update footer status
function updateStatus(): void {
  if (!server || !globalCtx) return;
  
  const statusText = clients.size > 0 
    ? `🟢 ${clients.size} client${clients.size !== 1 ? "s" : ""}` 
    : "🟡 Waiting";
  
  globalCtx.ui.setStatus("gateway", statusText);
}

const DEFAULT_CONFIG: GatewayConfig = {
  port: 3847,
  host: "localhost",
  tokens: [],
  corsOrigins: ["*"],
  enableWebSocket: true,
  enableHttp: true,
};

let config: GatewayConfig;
let server: ReturnType<typeof createServer> | null = null;
let wss: WebSocketServer | null = null;
let clients: Map<string, ClientSession> = new Map();
let currentAgentSession: unknown = null;
let rpcProcess: ReturnType<typeof import("node:child_process").spawn> | null = null;

function loadConfig(): GatewayConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) };
    }
  } catch {
    // Ignore
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch {
    // Ignore
  }
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function hashToken(token: string): string {
  return createHmac("sha256", "pi-gateway").update(token).digest("hex");
}

function verifyToken(token: string): boolean {
  if (config.tokens.length === 0) return true; // No tokens configured = allow all
  return config.tokens.includes(token);
}

function authenticate(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth) return verifyToken(""); // Check empty token
  
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    return verifyToken(token);
  }
  
  return false;
}

function sendWs(client: ClientSession, msg: WsMessage): void {
  if (client.ws && client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(msg));
  }
}

function broadcast(event: string, data: unknown): void {
  for (const client of clients.values()) {
    sendWs(client, { type: event, data });
  }
}

function createRpcProcess(): unknown {
  const { spawn } = require("node:child_process");
  
  const proc = spawn("pi", ["--mode", "rpc", "--json"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const messages: Array<{ id: string; data: unknown }> = [];

  proc.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        
        if (msg.id) {
          messages.push({ id: msg.id, data: msg });
          
          // Resolve any pending promises
          const idx = pendingRequests.findIndex(r => r.id === msg.id);
          if (idx !== -1) {
            const req = pendingRequests.splice(idx, 1)[0];
            req.resolve(msg);
          }
        }

        // Broadcast events to all WebSocket clients
        if (msg.type === "response") {
          const client = Array.from(clients.values())[0];
          if (client) {
            sendWs(client, { type: "response", id: msg.id, data: msg });
          }
        } else {
          broadcast("event", msg);
        }
      } catch {
        // Not JSON, might be log output
      }
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    console.error("[pi-gateway] pi stderr:", data.toString());
  });

  proc.on("error", (err: Error) => {
    console.error("[pi-gateway] pi process error:", err);
  });

  proc.on("exit", (code: number) => {
    console.log("[pi-gateway] pi process exited with code:", code);
    rpcProcess = null;
    broadcast("agent_disconnected", { code });
  });

  return proc;
}

interface PendingRequest {
  id: string;
  resolve: (msg: unknown) => void;
  reject: (err: Error) => void;
}

const pendingRequests: PendingRequest[] = [];

async function sendRpc(command: string, data: Record<string, unknown> = {}): Promise<unknown> {
  if (!rpcProcess || !("stdin" in rpcProcess)) {
    throw new Error("pi agent not running. Use /gateway start");
  }

  const id = randomBytes(8).toString("hex");
  const payload = { id, type: command, ...data };

  return new Promise((resolve, reject) => {
    pendingRequests.push({ id, resolve, reject });
    
    try {
      (rpcProcess as { stdin: { write: (d: string) => boolean } }).stdin.write(JSON.stringify(payload) + "\n");
    } catch (err) {
      const idx = pendingRequests.findIndex(r => r.id === id);
      if (idx !== -1) pendingRequests.splice(idx, 1);
      reject(err);
    }

    // Timeout after 30 seconds
    setTimeout(() => {
      const idx = pendingRequests.findIndex(r => r.id === id);
      if (idx !== -1) {
        pendingRequests.splice(idx, 1);
        reject(new Error("Request timeout"));
      }
    }, 30000);
  });
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", config.corsOrigins.join(",") || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!authenticate(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // REST API endpoints
  if (url.pathname === "/api/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      connected: rpcProcess !== null,
      port: config.port,
      clients: clients.size,
    }));
    return;
  }

  if (url.pathname === "/api/prompt" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { message, streaming } = JSON.parse(body);
        
        if (streaming) {
          // For streaming, use WebSocket
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Use WebSocket for streaming" }));
        } else {
          const result = await sendRpc("prompt", { message });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  if (url.pathname === "/api/models" && req.method === "GET") {
    try {
      const result = await sendRpc("get_available_models", {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    try {
      const result = await sendRpc("get_state", {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // Serve simple status page
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>pi Gateway</title>
  <style>
    body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; }
    h1 { color: #6366f1; }
    .status { padding: 10px; border-radius: 5px; margin: 10px 0; }
    .connected { background: #dcfce7; color: #166534; }
    .disconnected { background: #fee2e2; color: #991b1b; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>pi Gateway</h1>
  <div class="status ${rpcProcess ? 'connected' : 'disconnected'}">
    ${rpcProcess ? '✅ Agent Connected' : '❌ Agent Not Running'}
  </div>
  <p>Connected clients: <strong>${clients.size}</strong></p>
  <p>Port: <strong>${config.port}</strong></p>
  <h2>WebSocket URL</h2>
  <p><code>ws://localhost:${config.port}/ws</code></p>
  <h2>REST API</h2>
  <ul>
    <li><code>GET /api/status</code> - Gateway status</li>
    <li><code>GET /api/state</code> - Agent state</li>
    <li><code>GET /api/models</code> - Available models</li>
    <li><code>POST /api/prompt</code> - Send prompt</li>
  </ul>
</body>
</html>
    `);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

function handleWebSocket(ws: WebSocket, req: IncomingMessage): void {
  if (!authenticate(req)) {
    ws.close(1008, "Unauthorized");
    return;
  }

  const clientId = randomBytes(8).toString("hex");
  const client: ClientSession = { id: clientId, ws, lastActivity: Date.now() };
  clients.set(clientId, client);

  console.log(`[pi-gateway] Client connected: ${clientId}`);

  // Update footer status
  updateStatus();

  // Send welcome
  sendWs(client, { type: "connected", data: { clientId, agentConnected: rpcProcess !== null } });

  ws.on("message", async (data) => {
    try {
      const msg: WsMessage = JSON.parse(data.toString());
      client.lastActivity = Date.now();

      switch (msg.type) {
        case "prompt": {
          if (!rpcProcess) {
            sendWs(client, { type: "error", id: msg.id, data: { error: "Agent not running" } });
            return;
          }
          const result = await sendRpc("prompt", { 
            message: (msg.data as { message?: string })?.message || "",
            streamingBehavior: "steer",
          });
          sendWs(client, { type: "response", id: msg.id, data: result });
          break;
        }

        case "steer": {
          if (!rpcProcess) {
            sendWs(client, { type: "error", id: msg.id, data: { error: "Agent not running" } });
            return;
          }
          const result = await sendRpc("steer", { 
            message: (msg.data as { message?: string })?.message || "",
          });
          sendWs(client, { type: "response", id: msg.id, data: result });
          break;
        }

        case "abort": {
          if (!rpcProcess) {
            sendWs(client, { type: "error", id: msg.id, data: { error: "Agent not running" } });
            return;
          }
          const result = await sendRpc("abort", {});
          sendWs(client, { type: "response", id: msg.id, data: result });
          break;
        }

        case "get_state": {
          const result = await sendRpc("get_state", {});
          sendWs(client, { type: "response", id: msg.id, data: result });
          break;
        }

        case "get_models": {
          const result = await sendRpc("get_available_models", {});
          sendWs(client, { type: "response", id: msg.id, data: result });
          break;
        }

        case "set_model": {
          const modelData = msg.data as { provider?: string; modelId?: string };
          const result = await sendRpc("set_model", {
            provider: modelData?.provider,
            modelId: modelData?.modelId,
          });
          sendWs(client, { type: "response", id: msg.id, data: result });
          break;
        }

        case "new_session": {
          const result = await sendRpc("new_session", {});
          sendWs(client, { type: "response", id: msg.id, data: result });
          break;
        }

        case "ping": {
          sendWs(client, { type: "pong", data: { time: Date.now() } });
          break;
        }

        default:
          sendWs(client, { type: "error", id: msg.id, data: { error: `Unknown message type: ${msg.type}` } });
      }
    } catch (err) {
      console.error("[pi-gateway] WebSocket error:", err);
      sendWs(client, { type: "error", data: { error: String(err) } });
    }
  });

  ws.on("close", () => {
    clients.delete(clientId);
    console.log(`[pi-gateway] Client disconnected: ${clientId}`);
    updateStatus();
  });

  ws.on("error", (err) => {
    console.error(`[pi-gateway] Client ${clientId} error:`, err);
  });
}

export default function (pi: ExtensionAPI) {
  config = loadConfig();

  // Ensure config directory exists
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  // Register /gateway command
  pi.registerCommand("gateway", {
    description: "Manage pi Gateway HTTP/WebSocket server",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = ["start", "stop", "status", "token", "port", "restart"];
      return subcommands
        .filter(cmd => cmd.startsWith(prefix))
        .map(cmd => ({ value: cmd, label: cmd }));
    },
    handler: async (args, ctx) => {
      const parts = args.split(/\s+/).filter(Boolean);
      const subcmd = parts[0]?.toLowerCase();

      switch (subcmd) {
        case "start": {
          if (server) {
            ctx.ui.notify("Gateway already running on port " + config.port, "info");
            return;
          }

          const port = parseInt(parts[1]) || config.port;

          server = createServer(handleHttpRequest);
          
          if (config.enableWebSocket) {
            wss = new WebSocketServer({ server });
            wss.on("connection", handleWebSocket);
          }

          server.listen(port, config.host, () => {
            console.log(`[pi-gateway] HTTP server started on ${config.host}:${port}`);
          });

          // Start the pi agent in RPC mode
          currentAgentSession = createRpcProcess();

          ctx.ui.notify(`✅ Gateway started on http://${config.host}:${port}\n\nUse /gateway status to see details.`, "success");
          
          // Update footer status
          updateStatus();
          return;
        }

        case "stop": {
          if (!server) {
            ctx.ui.notify("Gateway not running", "info");
            return;
          }

          // Close all WebSocket clients
          for (const client of clients.values()) {
            client.ws?.close(1000, "Server shutting down");
          }
          clients.clear();

          server.close();
          server = null;
          wss = null;

          // Kill pi process
          if (rpcProcess) {
            (rpcProcess as { kill: () => void }).kill();
            rpcProcess = null;
          }

          ctx.ui.notify("Gateway stopped", "success");
          
          // Clear footer status
          globalCtx?.ui.setStatus("gateway", "");
          return;
        }

        case "status": {
          const lines: string[] = [];
          lines.push(`Status: ${server ? "🟢 Running" : "🔴 Stopped"}`);
          lines.push(`Port: ${config.port}`);
          lines.push(`Host: ${config.host}`);
          lines.push(`Clients: ${clients.size}`);
          lines.push(`Agent: ${rpcProcess ? "✅ Connected" : "❌ Disconnected"}`);
          lines.push("");
          lines.push(`WebSocket: ${config.enableWebSocket ? "Enabled" : "Disabled"}`);
          lines.push(`HTTP API: ${config.enableHttp ? "Enabled" : "Disabled"}`);
          lines.push(`Tokens: ${config.tokens.length > 0 ? config.tokens.length + " configured" : "None (open)"}`);
          lines.push("");
          lines.push("Endpoints:");
          lines.push(`  http://${config.host}:${config.port}/`);
          lines.push(`  ws://${config.host}:${config.port}/ws`);

          ctx.ui.setWidget("gateway-status", lines, { placement: "belowEditor" });
          setTimeout(() => ctx.ui.setWidget("gateway-status", undefined), 15000);
          return;
        }

        case "token": {
          const tokenAction = parts[1]?.toLowerCase();

          if (tokenAction === "generate" || tokenAction === "add") {
            const token = generateToken();
            config.tokens.push(token);
            saveConfig();

            ctx.ui.notify(
              `✅ Token generated:\n\n\`${token}\`\n\n` +
              "Share this token with clients. Include in requests:\n" +
              "Authorization: Bearer <token>",
              "success"
            );
            return;
          }

          if (tokenAction === "list") {
            if (config.tokens.length === 0) {
              ctx.ui.notify("No tokens configured (gateway is open)", "info");
            } else {
              ctx.ui.notify(
                "Active tokens:\n" +
                config.tokens.map((t, i) => `${i + 1}. ${t.slice(0, 8)}...`).join("\n"),
                "info"
              );
            }
            return;
          }

          if (tokenAction === "clear") {
            config.tokens = [];
            saveConfig();
            ctx.ui.notify("All tokens cleared", "success");
            return;
          }

          if (tokenAction === "remove" || tokenAction === "rm") {
            const idx = parseInt(parts[2]) - 1;
            if (isNaN(idx) || idx < 0 || idx >= config.tokens.length) {
              ctx.ui.notify("Invalid token index", "error");
              return;
            }
            config.tokens.splice(idx, 1);
            saveConfig();
            ctx.ui.notify("Token removed", "success");
            return;
          }

          ctx.ui.notify(
            "Token Commands:\n" +
            "  /gateway token generate   - Generate new token\n" +
            "  /gateway token list      - List tokens\n" +
            "  /gateway token remove <n>- Remove token by index\n" +
            "  /gateway token clear     - Remove all tokens",
            "info"
          );
          return;
        }

        case "port": {
          const port = parseInt(parts[1]);
          if (isNaN(port) || port < 1 || port > 65535) {
            ctx.ui.notify(`Current port: ${config.port}`, "info");
            return;
          }
          config.port = port;
          saveConfig();
          ctx.ui.notify(`Port set to ${port}. Restart with /gateway restart to apply.`, "success");
          return;
        }

        case "restart": {
          if (server) {
            // Stop first
            for (const client of clients.values()) {
              client.ws?.close(1000, "Server restarting");
            }
            clients.clear();
            server.close();
            server = null;
            wss = null;
            if (rpcProcess) {
              (rpcProcess as { kill: () => void }).kill();
              rpcProcess = null;
            }
          }
          // Start with new config
          server = createServer(handleHttpRequest);
          if (config.enableWebSocket) {
            wss = new WebSocketServer({ server });
            wss.on("connection", handleWebSocket);
          }
          server.listen(config.port, config.host, () => {
            ctx.ui.notify(`Gateway restarted on http://${config.host}:${config.port}`, "success");
          });
          currentAgentSession = createRpcProcess();
          return;
        }

        default: {
          ctx.ui.notify(
            "pi Gateway Commands:\n\n" +
            "  /gateway start [port]  - Start gateway server\n" +
            "  /gateway stop         - Stop gateway server\n" +
            "  /gateway restart      - Restart gateway\n" +
            "  /gateway status       - Show status & endpoints\n" +
            "  /gateway port <n>     - Set port number\n" +
            "  /gateway token ...    - Manage access tokens\n\n" +
            "Token subcommands:\n" +
            "  token generate - Create new token\n" +
            "  token list     - Show tokens\n" +
            "  token remove N - Remove token N\n" +
            "  token clear    - Remove all tokens",
            "info"
          );
        }
      }
    },
  });

  // Register tools
  pi.registerTool({
    name: "gateway_status",
    label: "Gateway Status",
    description: "Check pi Gateway server status and connected clients",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{
          type: "text",
          text: `Gateway: ${server ? "Running" : "Stopped"}\n` +
                `Port: ${config.port}\n` +
                `Clients: ${clients.size}\n` +
                `Agent: ${rpcProcess ? "Connected" : "Disconnected"}`
        }],
      };
    },
  });

  pi.registerTool({
    name: "gateway_clients",
    label: "Gateway Clients",
    description: "List all connected WebSocket clients",
    parameters: Type.Object({}),
    async execute() {
      const clientList = Array.from(clients.values()).map(c => ({
        id: c.id,
        lastActivity: new Date(c.lastActivity).toISOString(),
      }));
      return {
        content: [{
          type: "text",
          text: `Connected clients: ${clients.size}\n` +
                JSON.stringify(clientList, null, 2)
        }],
      };
    },
  });

  // Notify on session start
  pi.on("session_start", async (_event, ctx) => {
    globalCtx = ctx;
    updateStatus();
  });
}
