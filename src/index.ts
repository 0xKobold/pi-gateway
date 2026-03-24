/**
 * pi-gateway - Hermes-style Messaging Gateway for pi-coding-agent
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { randomBytes } from "node:crypto";

import type { ExtensionAPI, ExtensionContext, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import type { GatewayConfig, GatewayState, Platform, PlatformMessage, PlatformAdapter, WsMessage, Session } from "./types.js";
import { gatewayUI } from "./ui/gateway-ui.js";
import { initSessionStore, getOrCreateSession, listSessions, addMessage, getSession, getSessionStats } from "./sessions/store.js";
import { initSecurityStore, isUserAllowed, approvePairingCode, generatePairingCode, listPendingPairingCodes, addToAllowlist, listAllowlistedUsers } from "./security/auth.js";

// Config
const KOBOLD_DIR = join(homedir(), ".0xkobold");
const GATEWAY_DIR = join(KOBOLD_DIR, "gateway");
const CONFIG_FILE = join(GATEWAY_DIR, "config.json");

const DEFAULT_CONFIG: GatewayConfig = {
  port: 3847,
  host: "localhost",
  tokens: [],
  corsOrigins: ["*"],
  security: { allowAll: true, requirePairing: false },
  sessions: { resetPolicy: "idle", dailyHour: 4, idleMinutes: 1440 },
  platforms: {},
};

// State
let config: GatewayConfig;
let state: GatewayState;
let server: ReturnType<typeof createServer> | null = null;
let wss: WebSocketServer | null = null;
const adapters: Map<Platform, PlatformAdapter> = new Map();

function loadConfig(): GatewayConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(): void {
  try {
    if (!existsSync(GATEWAY_DIR)) mkdirSync(GATEWAY_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch { /* ignore */ }
}

function verifyToken(token: string): boolean {
  return config.tokens.length === 0 || config.tokens.includes(token);
}

function authenticate(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth) return verifyToken("");
  if (auth.startsWith("Bearer ")) return verifyToken(auth.slice(7));
  return false;
}

function sendWs(ws: any, msg: WsMessage): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastClients(event: string, data: unknown): void {
  for (const client of state.clients.values()) {
    sendWs(client, { type: event, data });
  }
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", config.corsOrigins.join(",") || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (!authenticate(req)) { res.writeHead(401); res.end(JSON.stringify({ error: "Unauthorized" })); return; }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === "/api/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ running: state.running, clients: state.clients.size, sessions: state.sessions.size, platforms: Array.from(state.adapters.keys()) }));
    return;
  }

  if (url.pathname === "/api/sessions" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(listSessions().map(s => ({ id: s.id, platform: s.platform, channelId: s.channelId, messageCount: s.messages.length }))));
    return;
  }

  if (url.pathname === "/api/allowlist" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(listAllowlistedUsers()));
    return;
  }

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><head><title>pi Gateway</title></head><body>
      <h1>pi Gateway</h1>
      <p>Status: ${state.running ? "🟢 Running" : "🔴 Stopped"}</p>
      <p>Clients: ${state.clients.size}</p>
      <p>Platforms: ${state.adapters.size}</p>
    </body></html>`);
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: "Not found" }));
}

function handleWebSocket(ws: any, req: IncomingMessage): void {
  if (!authenticate(req)) { ws.close(1008, "Unauthorized"); return; }

  const clientId = randomBytes(8).toString("hex");
  state.clients.set(clientId, ws);
  console.log(`[pi-gateway] Client connected: ${clientId}`);
  gatewayUI.notify(`Client connected: ${clientId.slice(0, 8)}`, "info");
  gatewayUI.updateFromState(state);
  sendWs(ws, { type: "connected", data: { clientId } });

  ws.on("message", async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case "ping": sendWs(ws, { type: "pong", data: { time: Date.now() } }); break;
        case "message": {
          const { platform = "websocket", channelId = clientId, userId = clientId, content } = msg.data || {};
          if (!isUserAllowed(platform as Platform, userId)) {
            sendWs(ws, { type: "error", data: { error: "Not authorized" } }); return;
          }
          const session = getOrCreateSession(platform as Platform, channelId, userId);
          addMessage(session.id, "user", content);
          const response = `Gateway received: ${content}`;
          addMessage(session.id, "assistant", response);
          sendWs(ws, { type: "response", data: { sessionId: session.id, response } });
          break;
        }
        default:
          sendWs(ws, { type: "error", data: { error: `Unknown type: ${msg.type}` } });
      }
    } catch (err) {
      sendWs(ws, { type: "error", data: { error: String(err) } });
    }
  });

  ws.on("close", () => { state.clients.delete(clientId); gatewayUI.updateFromState(state); });
}

async function handlePlatformMessage(message: PlatformMessage): Promise<void> {
  if (!isUserAllowed(message.platform, message.userId)) {
    const adapter = adapters.get(message.platform);
    if (adapter) await adapter.sendMessage(message.channelId, "You are not authorized to use this gateway.");
    return;
  }

  const session = getOrCreateSession(message.platform, message.channelId, message.userId);
  addMessage(session.id, "user", message.content);
  const response = `Gateway received via ${message.platform}: ${message.content.slice(0, 100)}`;
  addMessage(session.id, "assistant", response);

  const adapter = adapters.get(message.platform);
  if (adapter) {
    await adapter.sendMessage(message.channelId, response);
    await adapter.setTyping(message.channelId, false);
  }
  state.stats.totalMessages++;
  gatewayUI.updateFromState(state);
}

function startGateway(port?: number): void {
  if (state.running) { gatewayUI.notify("Gateway already running", "warning"); return; }

  initSessionStore();
  initSecurityStore();

  server = createServer(handleHttpRequest);
  wss = new WebSocketServer({ server });
  wss.on("connection", handleWebSocket);

  const gatewayPort = port || config.port;
  server.listen(gatewayPort, config.host, () => {
    console.log(`[pi-gateway] Started on ${config.host}:${gatewayPort}`);
    gatewayUI.notify(`Gateway started on http://${config.host}:${gatewayPort}`, "success");
  });

  state.running = true;
  state.startedAt = Date.now();
  gatewayUI.updateFromState(state);
}

function stopGateway(): void {
  if (!state.running) { gatewayUI.notify("Gateway not running", "warning"); return; }

  for (const adapter of adapters.values()) adapter.stop().catch(console.error);
  adapters.clear();
  for (const client of state.clients.values()) client.close(1000, "Shutting down");
  state.clients.clear();
  server?.close();
  server = null; wss = null;

  state.running = false;
  gatewayUI.setStatus("gateway", "🔴 Gateway");
  gatewayUI.notify("Gateway stopped", "success");
}

export default function (pi: ExtensionAPI) {
  config = loadConfig();
  state = { running: false, adapters: new Map(), sessions: new Map(), clients: new Map(), stats: { totalMessages: 0, totalSessions: 0, activePlatforms: 0, uptime: 0 } };
  gatewayUI.setContext(pi as unknown as ExtensionContext);

  pi.registerCommand("gateway", {
    description: "Hermes-style messaging gateway",
    getArgumentCompletions: (prefix: string) => ["start", "stop", "status", "restart", "sessions", "pair", "allow", "config", "platforms", "help"].filter(c => c.startsWith(prefix)).map(c => ({ value: c, label: c })),
    handler: async (args, ctx) => {
      const parts = args.split(/\s+/).filter(Boolean);
      const subcmd = parts[0]?.toLowerCase();

      switch (subcmd) {
        case "start": startGateway(parseInt(parts[1]) || config.port); break;
        case "stop": stopGateway(); break;
        case "restart": stopGateway(); startGateway(config.port); break;
        case "status": gatewayUI.showStatusWidget(state, config); break;
        case "sessions": {
          const sessions = listSessions();
          gatewayUI.setWidget("sessions", [`Sessions: ${sessions.length}`, "", ...sessions.slice(0, 10).map(s => `${s.platform}:${s.channelId} (${s.messages.length} msgs)`)], { placement: "belowEditor", timeout: 15000 });
          break;
        }
        case "pair": {
          const code = parts[1]?.toUpperCase();
          if (!code) { gatewayUI.notify("Pending: " + listPendingPairingCodes().map(p => p.code).join(", ") || "None", "info"); return; }
          gatewayUI.notify(approvePairingCode(code) ? `Code ${code} approved` : "Invalid code", approvePairingCode(code) ? "success" : "error");
          break;
        }
        case "allow": {
          const platform = parts[1] as Platform;
          const userId = parts[2];
          if (!platform || !userId) { gatewayUI.notify("Allowlist: " + listAllowlistedUsers().map(u => `${u.platform}:${u.userId}`).join(", ") || "None", "info"); return; }
          addToAllowlist(platform, userId);
          gatewayUI.notify(`Added ${platform}:${userId}`, "success");
          break;
        }
        case "config": gatewayUI.setWidget("config", [`Port: ${config.port}`, `Security: ${config.security.allowAll ? "Allow all" : "Allowlist"}`, `Sessions: ${config.sessions.resetPolicy}`], { placement: "belowEditor", timeout: 15000 }); break;
        case "platforms": gatewayUI.setWidget("platforms", ["Platforms:", ...Array.from(adapters.keys()).map(p => `${p}: ${adapters.get(p)?.getStatus().connected ? "🟢" : "🔴"}`)], { placement: "belowEditor", timeout: 15000 }); break;
        default: gatewayUI.showHelpWidget();
      }
    },
  });

  pi.registerTool({
    name: "gateway_status",
    label: "Gateway Status",
    description: "Check Hermes-style gateway status",
    parameters: Type.Object({}),
    async execute(): Promise<AgentToolResult<any>> {
      return { content: [{ type: "text" as const, text: JSON.stringify({ running: state.running, clients: state.clients.size, sessions: getSessionStats(), platforms: Array.from(state.adapters.keys()) }, null, 2) }] };
    },
  });

  pi.registerTool({
    name: "gateway_sessions",
    label: "Gateway Sessions",
    description: "List active gateway sessions",
    parameters: Type.Object({}),
    async execute(): Promise<AgentToolResult<any>> {
      return { content: [{ type: "text" as const, text: JSON.stringify(listSessions().map(s => ({ id: s.id.slice(0, 12), platform: s.platform, channelId: s.channelId, messageCount: s.messages.length })), null, 2) }] };
    },
  });

  pi.registerTool({
    name: "gateway_pairing",
    label: "Gateway Pairing",
    description: "Generate or approve pairing codes",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("generate"), Type.Literal("list"), Type.Literal("approve")]),
      platform: Type.Optional(Type.String()),
      userId: Type.Optional(Type.String()),
      code: Type.Optional(Type.String()),
    }),
    async execute({ action, platform, userId, code }: { action: string; platform?: string; userId?: string; code?: string }): Promise<AgentToolResult> {
      switch (action) {
        case "generate": return { content: [{ type: "text" as const, text: `Code: ${generatePairingCode(platform as Platform, userId!)}` }] };
        case "list": return { content: [{ type: "text" as const, text: JSON.stringify(listPendingPairingCodes(), null, 2) }] };
        case "approve": return { content: [{ type: "text" as const, text: approvePairingCode(code!) ? "Approved" : "Invalid" }] };
      }
    },
  });

  pi.on("session_start", () => {
    gatewayUI.notify("pi Gateway loaded (Hermes-style)", "info");
  });

  console.log("[pi-gateway] Hermes-style gateway extension loaded");
}
