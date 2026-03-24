# pi-gateway Skill

HTTP/WebSocket gateway that exposes the pi agent to external clients (web, mobile, etc.).

## Usage

### Commands

- `/gateway start [port]` - Start the gateway server (default port: 3847)
- `/gateway stop` - Stop the gateway server
- `/gateway status` - Show gateway status
- `/gateway restart` - Restart the gateway server
- `/gateway token generate` - Generate an access token
- `/gateway port <n>` - Change the server port

### HTTP API

| Endpoint | Method | Description |
|---------|--------|-------------|
| `/` | GET | Gateway status page |
| `/api/status` | GET | Server status & client count |
| `/api/models` | GET | Available AI models |
| `/api/state` | GET | Current agent state |
| `/api/prompt` | POST | Send a prompt |

### WebSocket

Connect to `ws://localhost:3847/ws`

#### Messages (send)

```json
{ "type": "prompt", "data": { "message": "Hello!" } }
{ "type": "abort" }
{ "type": "ping" }
{ "type": "get_state" }
{ "type": "get_models" }
{ "type": "set_model", "data": { "model": "claude-sonnet-4" } }
```

#### Messages (receive)

```json
{ "type": "connected", "data": { "clientId": "...", "agentConnected": true } }
{ "type": "event", "data": { "assistantMessageEvent": { "type": "text_delta", "delta": "H" } } }
{ "type": "response", "data": { "success": true } }
```

### Configuration

Config stored at `~/.pi/gateway/config.json`:

```json
{
  "port": 3847,
  "host": "localhost",
  "tokens": [],
  "corsOrigins": ["*"]
}
```

### Example Client (JavaScript)

```javascript
const ws = new WebSocket('ws://localhost:3847/ws');

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'prompt',
    data: { message: 'Hello!' }
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'event') {
    process.stdout.write(msg.data.assistantMessageEvent.delta);
  } else if (msg.type === 'response') {
    console.log('\n[DONE]');
  }
};
```

## Files

- `index.ts` - Main extension
- `tests/demo-server.ts` - Demo server for testing
- `tests/index.ts` - Unit & integration tests
