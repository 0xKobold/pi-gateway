# pi Gateway

HTTP/WebSocket gateway that exposes your pi agent to external clients. Chat with your pi agent from web browsers, mobile apps, or any HTTP client.

## Features

- 🌐 **HTTP REST API** - Simple endpoints for prompts and state
- 🔌 **WebSocket Support** - Real-time streaming for agent output
- 🔐 **Token Authentication** - Secure access with bearer tokens
- 📡 **Multi-client** - Multiple clients can connect simultaneously
- 🔄 **Full RPC Protocol** - Complete pi agent control via RPC

## Quick Start

### 1. Install the extension

The extension is already symlinked at `~/.pi/agent/extensions/pi-gateway.ts`

### 2. Start the gateway

```bash
# In pi agent, run:
/gateway start
```

This starts the gateway on port 3847.

### 3. Connect a client

Open `http://localhost:3847/` in a browser for the status page.

Or connect via WebSocket:

```javascript
const ws = new WebSocket('ws://localhost:3847/ws');

ws.onopen = () => {
  console.log('Connected!');
  
  // Send a prompt
  ws.send(JSON.stringify({
    type: 'prompt',
    data: { message: 'Hello, what files are in the current directory?' }
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  
  if (msg.type === 'event') {
    // Agent streaming output
    console.log('Event:', msg.data);
  }
  
  if (msg.type === 'response') {
    // Request completed
    console.log('Response:', msg.data);
  }
};
```

## Commands

| Command | Description |
|---------|-------------|
| `/gateway start [port]` | Start gateway server |
| `/gateway stop` | Stop gateway server |
| `/gateway restart` | Restart gateway |
| `/gateway status` | Show status & endpoints |
| `/gateway port <n>` | Set port number |
| `/gateway token generate` | Generate access token |
| `/gateway token list` | List tokens |
| `/gateway token clear` | Remove all tokens |

## Footer Status

When the gateway is running, you'll see a status indicator in the pi footer:

```
┌─────────────────────────────────────────┐
│ 🟢 2 clients                    [pi]   │  ← Footer
└─────────────────────────────────────────┘
```

- **🟢 N clients** - Gateway running with N connected clients
- **🟡 Waiting** - Gateway running but no clients connected

The status updates in real-time as clients connect and disconnect.

## API Reference

### HTTP Endpoints

#### GET /
Status page with gateway info.

#### GET /api/status
```json
{
  "connected": true,
  "port": 3847,
  "clients": 2
}
```

#### GET /api/state
Returns current agent state (model, session info, etc.)

#### GET /api/models
Returns available AI models.

#### POST /api/prompt
```bash
curl -X POST http://localhost:3847/api/prompt \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!"}'
```

### WebSocket Messages

Connect to `ws://localhost:3847/ws`

#### Send: prompt
```json
{
  "type": "prompt",
  "id": "req-1",
  "data": {
    "message": "List files in current directory"
  }
}
```

#### Send: steer
Steer the agent while it's running:
```json
{
  "type": "steer",
  "data": {
    "message": "Stop and do something else"
  }
}
```

#### Send: abort
Abort current operation:
```json
{
  "type": "abort"
}
```

#### Send: get_state
Get agent state:
```json
{
  "type": "get_state"
}
```

#### Send: get_models
List available models:
```json
{
  "type": "get_models"
}
```

#### Send: set_model
Switch model:
```json
{
  "type": "set_model",
  "data": {
    "provider": "anthropic",
    "modelId": "claude-sonnet-4-20250514"
  }
}
```

#### Send: new_session
Start fresh session:
```json
{
  "type": "new_session"
}
```

#### Send: ping
Keepalive:
```json
{
  "type": "ping"
}
```

### Received Events

The gateway streams these events:

```json
{
  "type": "event",
  "data": {
    "event": "message_update",
    "data": { "type": "text_delta", "delta": "Hello" }
  }
}
```

## Authentication

### Without tokens (development)
```bash
/gateway start
# No auth required
```

### With tokens (production)
```bash
/gateway token generate
# Outputs: ✅ Token generated: abc123...

# Client usage:
const ws = new WebSocket('ws://localhost:3847/ws', {
  headers: { 'Authorization': 'Bearer abc123...' }
});
```

## Example Clients

### HTML/JS Client

```html
<!DOCTYPE html>
<html>
<head>
  <title>pi Client</title>
  <style>
    body { font-family: system-ui; max-width: 800px; margin: 0 auto; padding: 20px; }
    #chat { height: 400px; overflow-y: auto; border: 1px solid #ccc; padding: 10px; margin-bottom: 10px; }
    .msg { margin: 5px 0; padding: 8px; border-radius: 5px; }
    .user { background: #e0e7ff; }
    .agent { background: #f1f5f9; }
    #input { width: calc(100% - 80px); padding: 8px; }
    button { padding: 8px 16px; }
  </style>
</head>
<body>
  <h1>pi Client</h1>
  <div id="status">Connecting...</div>
  <div id="chat"></div>
  <input id="input" placeholder="Ask pi...">
  <button onclick="send()">Send</button>

  <script>
    const chat = document.getElementById('chat');
    const status = document.getElementById('status');
    const input = document.getElementById('input');
    
    const ws = new WebSocket('ws://localhost:3847/ws');
    
    ws.onopen = () => status.textContent = '🟢 Connected';
    ws.onclose = () => status.textContent = '🔴 Disconnected';
    
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      
      if (msg.type === 'event') {
        // Stream text deltas
        if (msg.data?.assistantMessageEvent?.type === 'text_delta') {
          appendMessage('agent', msg.data.assistantMessageEvent.delta, true);
        }
      }
      
      if (msg.type === 'connected') {
        chat.innerHTML = '';
        appendMessage('agent', 'Connected to pi!');
      }
    };
    
    function appendMessage(role, text, append = false) {
      let el = document.querySelector(`.msg.${role}:last-child`);
      if (!el || !append) {
        el = document.createElement('div');
        el.className = `msg ${role}`;
        chat.appendChild(el);
      }
      el.textContent = (el.textContent || '') + text;
      chat.scrollTop = chat.scrollHeight;
    }
    
    function send() {
      const text = input.value.trim();
      if (!text) return;
      
      appendMessage('user', text);
      input.value = '';
      
      ws.send(JSON.stringify({
        type: 'prompt',
        data: { message: text }
      }));
    }
    
    input.onkeypress = (e) => {
      if (e.key === 'Enter') send();
    };
  </script>
</body>
</html>
```

### Node.js Client

```javascript
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3847/ws');

ws.on('open', () => {
  console.log('Connected');
  
  // Send prompt
  ws.send(JSON.stringify({
    type: 'prompt',
    data: { message: 'What is 2 + 2?' }
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  
  if (msg.type === 'event') {
    const event = msg.data;
    if (event.assistantMessageEvent?.type === 'text_delta') {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  }
  
  if (msg.type === 'response') {
    console.log('\n\nRequest complete!');
  }
});
```

### Python Client

```python
import asyncio
import websockets
import json

async def main():
    uri = "ws://localhost:3847/ws"
    
    async with websockets.connect(uri) as ws:
        # Send prompt
        await ws.send(json.dumps({
            "type": "prompt",
            "data": {"message": "Hello!"}
        }))
        
        # Receive events
        async for message in ws:
            msg = json.loads(message)
            
            if msg["type"] == "event":
                event = msg["data"]
                if event.get("assistantMessageEvent", {}).get("type") == "text_delta":
                    print(event["assistantMessageEvent"]["delta"], end="")
            
            if msg["type"] == "response":
                print("\n\nDone!")
                break

asyncio.run(main())
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        pi Gateway                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐   │
│   │   HTTP API  │    │  WebSocket  │    │    Auth     │   │
│   │   Server    │    │   Server    │    │   Manager   │   │
│   └──────┬──────┘    └──────┬──────┘    └─────────────┘   │
│          │                  │                              │
│          └────────┬─────────┘                              │
│                   │                                        │
│          ┌────────▼────────┐                               │
│          │   Message       │                               │
│          │   Router        │                               │
│          └────────┬────────┘                               │
│                   │                                        │
│   ┌───────────────▼───────────────┐                        │
│   │         pi RPC Process         │                        │
│   │    (pi --mode rpc)            │                        │
│   └───────────────────────────────┘                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Configuration

Config stored at `~/.pi/gateway/config.json`:

```json
{
  "port": 3847,
  "host": "localhost",
  "tokens": [],
  "corsOrigins": ["*"],
  "enableWebSocket": true,
  "enableHttp": true
}
```

## Requirements

- Node.js 18+
- pi agent
- `ws` npm package (auto-installed with extension)

## Troubleshooting

### Gateway won't start
```bash
# Check if port is in use
lsof -i :3847

# Use a different port
/gateway start 8080
```

### "pi agent not running"
```bash
# Make sure pi is installed
which pi

# Reinstall if needed
npm install -g @mariozechner/pi-coding-agent
```

### WebSocket connection refused
```bash
# Verify gateway is running
/gateway status

# Check firewall rules
curl http://localhost:3847/api/status
```

## License

MIT
