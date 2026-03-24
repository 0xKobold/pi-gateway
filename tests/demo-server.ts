/**
 * pi-gateway Demo Server
 * Beautiful demo with Tailwind CSS UI + working WebSocket chat
 */

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = 3848;

const clients = new Set<WebSocket>();
let agentStreaming = false;

// Combined HTTP+WS server
const server = http.createServer();
const wss = new WebSocketServer({ server });

// WebSocket handling
wss.on("connection", (ws, req) => {
  const id = Math.random().toString(36).slice(2, 10);
  clients.add(ws);
  console.log(`[${id}] Connected (${clients.size} clients)`);

  ws.send(JSON.stringify({ type: "connected", data: { clientId: id } }));

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log(`[${id}] ${msg.type}`);

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", time: Date.now() }));
      } else if (msg.type === "prompt") {
        agentStreaming = true;
        const text = (msg.data as { message?: string })?.message || "Hello!";
        const response = generateResponse(text);
        let i = 0;
        const timer = setInterval(() => {
          if (i < response.length && agentStreaming) {
            ws.send(JSON.stringify({
              type: "event",
              data: { assistantMessageEvent: { type: "text_delta", delta: response[i] } }
            }));
            i++;
          } else {
            clearInterval(timer);
            agentStreaming = false;
            ws.send(JSON.stringify({ type: "response", id: msg.id, data: { success: true } }));
          }
        }, 10);
      } else if (msg.type === "abort") {
        agentStreaming = false;
        ws.send(JSON.stringify({ type: "response", id: msg.id, data: { aborted: true } }));
      } else {
        ws.send(JSON.stringify({ type: "response", id: msg.id, data: { success: true } }));
      }
    } catch (err) {
      console.error(`[${id}] Error:`, err);
      ws.send(JSON.stringify({ type: "error", data: { error: "Invalid JSON" } }));
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[${id}] Disconnected (${clients.size} clients)`);
  });

  ws.on("error", (err) => console.error(`[${id}] WS error:`, err.message));
});

// HTTP handling
server.on("request", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(getHtml());
    return;
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ connected: true, port: PORT, clients: clients.size }));
    return;
  }

  if (url.pathname === "/api/models" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      models: [
        { provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
        { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4" },
        { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
      ],
    }));
    return;
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
      thinkingLevel: "medium",
      isStreaming: agentStreaming,
      sessionId: "demo-session",
    }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

function generateResponse(prompt: string): string {
  const lower = prompt.toLowerCase();
  
  if (lower.includes("hello") || lower.includes("hi")) {
    return "Hello! I'm your pi agent. This demo shows how the gateway works - connect your browser or client app to chat in real-time with streaming responses!";
  }
  
  if (lower.includes("help")) {
    return "I can help you with:\n\n• Writing and editing code\n• Running shell commands\n• Reading and analyzing files\n• Creating new projects\n• Debugging issues\n• And much more!";
  }
  
  if (lower.includes("what") && lower.includes("you")) {
    return "I'm pi, an AI coding agent. I can:\n\n• Read and write files\n• Run terminal commands\n• Use tools (grep, find, edit)\n• Create skills and extensions\n• Think through complex problems";
  }
  
  if (lower.includes("time")) {
    return "The current time is " + new Date().toLocaleTimeString() + ".";
  }
  
  return `You said: "${prompt}" - This is a demo. Connect the real pi agent to unlock full capabilities!`;
}

function getHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>pi Gateway</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
  <style>
    body { font-family: Inter, sans-serif; }
    .glass { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px); }
    .messages::-webkit-scrollbar { width: 6px; }
    .messages::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 3px; }
  </style>
</head>
<body class="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
  <div class="max-w-5xl mx-auto p-6">
    
    <!-- Header -->
    <header class="glass rounded-2xl p-6 mb-6 flex items-center justify-between">
      <div class="flex items-center gap-4">
        <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg">
          <svg class="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
          </svg>
        </div>
        <div>
          <h1 class="text-2xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">pi Gateway</h1>
          <p class="text-sm text-slate-400">HTTP/WebSocket API for pi agent</p>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <div id="statusBadge" class="flex items-center gap-2 px-4 py-2 rounded-full bg-slate-800/50">
          <span id="statusDot" class="w-2 h-2 rounded-full bg-yellow-500"></span>
          <span id="statusText" class="text-sm">Connecting...</span>
        </div>
      </div>
    </header>

    <!-- Main Content -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      
      <!-- Chat Panel -->
      <div class="lg:col-span-2 glass rounded-2xl overflow-hidden">
        <div class="px-6 py-4 border-b border-white/10 flex items-center justify-between bg-white/5">
          <div class="flex items-center gap-3">
            <h2 class="font-semibold text-slate-200">Chat</h2>
            <span id="thinkingBadge" class="hidden px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 text-xs font-medium animate-pulse">
              Thinking...
            </span>
          </div>
          <button onclick="clearChat()" class="text-sm text-slate-400 hover:text-white transition-colors px-3 py-1 rounded-lg hover:bg-white/10">
            Clear
          </button>
        </div>
        
        <div id="messages" class="h-[450px] overflow-y-auto p-6 space-y-4 messages">
          <div id="emptyState" class="h-full flex flex-col items-center justify-center text-slate-500">
            <div class="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center mb-4">
              <svg class="w-8 h-8 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
              </svg>
            </div>
            <p class="text-lg mb-1">Start chatting</p>
            <p class="text-sm text-slate-600">Powered by pi agent</p>
          </div>
        </div>
        
        <div class="p-4 border-t border-white/10 bg-white/5">
          <form id="chatForm" class="flex gap-3">
            <input type="text" id="messageInput" placeholder="Ask pi anything..." 
              class="flex-1 px-4 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition-all text-white placeholder-slate-500"
              autocomplete="off">
            <button type="submit" id="sendBtn"
              class="px-6 py-3 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 font-medium transition-all shadow-lg shadow-indigo-500/25 disabled:opacity-50">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
              </svg>
            </button>
          </form>
        </div>
      </div>

      <!-- Sidebar -->
      <div class="space-y-4">
        
        <!-- Status -->
        <div class="glass rounded-xl p-5">
          <h3 class="font-semibold text-slate-200 mb-4 flex items-center gap-2">
            <svg class="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            Status
          </h3>
          <div class="space-y-3">
            <div class="flex justify-between items-center">
              <span class="text-slate-400 text-sm">Port</span>
              <code class="text-sm bg-white/10 px-2 py-1 rounded">${PORT}</code>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-slate-400 text-sm">Clients</span>
              <span id="clientCount" class="text-sm bg-white/10 px-2 py-1 rounded">0</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-slate-400 text-sm">Agent</span>
              <span id="agentStatus" class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full bg-green-500"></span>
                <span class="text-sm">Ready</span>
              </span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-slate-400 text-sm">Agent</span>
              <span id="agentStatus" class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full bg-green-500"></span>
                <span class="text-sm">Ready</span>
              </span>
            </div>
          </div>
        </div>

        <!-- WebSocket -->
        <div class="glass rounded-xl p-5">
          <h3 class="font-semibold text-slate-200 mb-4 flex items-center gap-2">
            <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101"/>
            </svg>
            WebSocket
          </h3>
          <div>
            <label class="text-xs text-slate-400 block mb-1">Endpoint</label>
            <code class="block text-xs bg-black/30 rounded-lg p-2 break-all font-mono">ws://localhost:${PORT}/ws</code>
          </div>
        </div>

        <!-- API -->
        <div class="glass rounded-xl p-5">
          <h3 class="font-semibold text-slate-200 mb-4 flex items-center gap-2">
            <svg class="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>
            </svg>
            API Endpoints
          </h3>
          <div class="space-y-2 text-sm">
            <div class="flex items-center gap-2">
              <span class="px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 text-xs font-medium">GET</span>
              <code class="text-slate-300 text-xs">/api/status</code>
            </div>
            <div class="flex items-center gap-2">
              <span class="px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 text-xs font-medium">GET</span>
              <code class="text-slate-300 text-xs">/api/models</code>
            </div>
            <div class="flex items-center gap-2">
              <span class="px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 text-xs font-medium">GET</span>
              <code class="text-slate-300 text-xs">/api/state</code>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <footer class="glass rounded-xl p-4 mt-6 flex items-center justify-between text-sm text-slate-400">
      <div class="flex items-center gap-2">
        <span id="footerClients" class="flex items-center gap-1.5">
          <span class="w-2 h-2 rounded-full bg-green-500"></span>
          <span id="footerClientCount">0</span> client(s)
        </span>
      </div>
      <div>
        <code class="text-xs font-mono">ws://localhost:${PORT}/ws</code>
      </div>
    </footer>
  </div>

  <script>
    const WS_URL = 'ws://localhost:${PORT}/ws';
    let ws = null;
    let isConnected = false;

    const messagesEl = document.getElementById('messages');
    const emptyState = document.getElementById('emptyState');
    const chatForm = document.getElementById('chatForm');
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const clientCount = document.getElementById('clientCount');
    const thinkingBadge = document.getElementById('thinkingBadge');
    const agentStatus = document.getElementById('agentStatus');

    function connect() {
      ws = new WebSocket(WS_URL);
      
      ws.onopen = () => {
        isConnected = true;
        statusDot.className = 'w-2 h-2 rounded-full bg-green-500 animate-pulse';
        statusText.textContent = 'Connected';
      };
      
      ws.onclose = () => {
        isConnected = false;
        statusDot.className = 'w-2 h-2 rounded-full bg-red-500';
        statusText.textContent = 'Reconnecting...';
        setTimeout(connect, 2000);
      };
      
      ws.onerror = () => {
        statusText.textContent = 'Error';
      };
      
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      };
    }

    function handleMessage(msg) {
      if (msg.type === 'event') {
        const delta = msg.data?.assistantMessageEvent?.delta;
        if (delta) {
          appendText(delta);
        }
      } else if (msg.type === 'response') {
        finishResponse();
      }
    }

    function addMessage(content, isUser = false) {
      if (emptyState && emptyState.parentNode) {
        emptyState.remove();
      }
      
      const div = document.createElement('div');
      div.className = 'flex ' + (isUser ? 'justify-end' : 'justify-start');
      div.innerHTML = \`<div class="max-w-[75%] rounded-2xl px-4 py-3 \${isUser ? 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white' : 'bg-white/10 text-slate-100'}"><p class="text-sm leading-relaxed whitespace-pre-wrap"></p></div>\`;
      messagesEl.appendChild(div);
      return div.querySelector('p');
    }

    function appendText(text) {
      const last = messagesEl.lastElementChild?.querySelector('p');
      if (last) {
        last.textContent += text;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    function startThinking() {
      thinkingBadge.classList.remove('hidden');
      sendBtn.disabled = true;
      messageInput.disabled = true;
      agentStatus.innerHTML = '<span class="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></span><span class="text-sm">Thinking...</span>';
    }

    function finishResponse() {
      thinkingBadge.classList.add('hidden');
      sendBtn.disabled = false;
      messageInput.disabled = false;
      agentStatus.innerHTML = '<span class="w-2 h-2 rounded-full bg-green-500"></span><span class="text-sm">Ready</span>';
      statusText.textContent = 'Connected';
    }

    function clearChat() {
      messagesEl.innerHTML = '';
      messagesEl.appendChild(emptyState);
      emptyState.style.display = 'flex';
    }

    chatForm.onsubmit = (e) => {
      e.preventDefault();
      const text = messageInput.value.trim();
      if (!text || !isConnected) return;
      
      addMessage(text, true);
      messageInput.value = '';
      startThinking();
      
      // Add agent placeholder
      addMessage('');
      
      ws.send(JSON.stringify({ type: 'prompt', data: { message: text } }));
    };

    // Update client count
    setInterval(async () => {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        clientCount.textContent = data.clients;
        document.getElementById('footerClientCount').textContent = data.clients;
        
        // Update footer dot color
        const footerClients = document.getElementById('footerClients');
        if (data.clients > 0) {
          footerClients.querySelector('span:first-child').className = 'w-2 h-2 rounded-full bg-green-500 animate-pulse';
        } else {
          footerClients.querySelector('span:first-child').className = 'w-2 h-2 rounded-full bg-gray-500';
        }
      } catch {}
    }, 2000);

    connect();
    messageInput.focus();
  </script>
</body>
</html>`;
}

// Start
server.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log("pi Gateway Demo");
  console.log("=".repeat(50));
  console.log("Open: http://localhost:" + PORT + "/");
  console.log("=".repeat(50));
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  for (const ws of clients) ws.close();
  wss.close();
  server.close(() => process.exit(0));
});
